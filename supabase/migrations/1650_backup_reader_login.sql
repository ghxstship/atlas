-- 1650_backup_reader_login.sql
--
-- The weekly production backup's own database login (ADR 0022, 1650-1659; ADR 0033, decision 47), RRR-139. The
-- `production` job of .github/workflows/backup-weekly.yml logs in as xos_backup and runs pg_dump, pg_dumpall and psql
-- from the Postgres image the pinned Supabase CLI uses (infra/ci/backup-weekly.sh --reader). `supabase db dump` cannot
-- use this login, because the CLI always switches to the postgres role. The login reads what a logical backup restores
-- and nothing else:
--   * the application schemas app, private and xpms: every table and sequence, now and later;
--   * from storage, the buckets and the object list;
--   * the accounts and the worker schedules, through two functions that return them as SQL, because postgres may not
--     grant USAGE on auth, and USAGE on cron would let the login schedule jobs; the accounts without their one-time
--     tokens;
--   * the versions in the migration history, through a third function, so a restore can record them again;
--   * through a fourth, with its own rights, the triggers, policies and grants XOS keeps on Supabase's auth and storage
--     tables, which no schema dump holds;
--   * no write privilege anywhere, no Vault, no auth table holding sessions or one-time tokens.
-- Each grant says below why the backup needs it. No password is set here: the login cannot sign in until the owner sets
-- one with psql's \password on each project (infra/runbooks/backup-and-restore.md), so no value enters the repository.
-- supabase/tests/1650_backup_reader_login.test.sql pins the role's attributes, every grant and every refusal.

-- 1. The role ----------------------------------------------------------------------------------------------------------

-- Roles belong to the cluster, so a project that already has the role keeps it and gets the attributes below.
-- NOSUPERUSER and NOREPLICATION are the defaults; naming them would need a superuser.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'xos_backup') then
    create role xos_backup;
  end if;
end;
$$;

-- LOGIN: the backup job connects as this role. BYPASSRLS: pg_dump turns row security off and refuses any table whose
-- policies would hide rows (every table in app, private and xpms has policies), so a login without it either fails or,
-- with --enable-row-security, dumps only what its own claims show, which is nothing. NOINHERIT and no memberships: it
-- holds only the grants below. CONNECTION LIMIT 2: the backup runs one client at a time.
alter role xos_backup with login noinherit nocreatedb nocreaterole bypassrls connection limit 2;

-- Every session starts read-only, a second guard beside the missing write grants.
alter role xos_backup set default_transaction_read_only = on;

comment on role xos_backup is 'Weekly production backup login (ADR 0033, decision 47; migration 1650): reads the application schemas, the storage object list, and the accounts, worker schedules and migration versions through private.backup_account_rows, private.backup_cron_schedules and private.backup_migration_versions, and XOS''s triggers, policies and grants on auth and storage through private.backup_platform_objects; writes nothing. Its password is set by the owner, never in a migration.';

-- 2. Application schemas -----------------------------------------------------------------------------------------------

-- USAGE and SELECT on every table: pg_dump locks each table it dumps in ACCESS SHARE mode, for the schema dump as well
-- as the data dump, and copies every row. SELECT on sequences: the data dump reads each sequence's last value.
-- api_public, api_external and public hold no table, and pg_dump reads views and functions from the catalogs, so they
-- need no grant. Views are not granted: pg_dump never reads their rows.
grant usage on schema app, private, xpms to xos_backup;

do $$
declare
  v_table regclass;
begin
  for v_table in
    select c.oid::regclass from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('app', 'private', 'xpms') and c.relkind in ('r', 'p')
    order by 1
  loop
    execute format('grant select on table %s to xos_backup', v_table);
  end loop;
end;
$$;

grant select on all sequences in schema app, private, xpms to xos_backup;

-- Tables and sequences later migrations create are read too, so a new table never breaks the weekly backup. Default
-- privileges cannot tell a table from a view, so later views are readable as well; the pgTAP test keeps every view the
-- login can read away from Vault and from the auth schema.
alter default privileges for role postgres in schema app, private, xpms grant select on tables to xos_backup;
alter default privileges for role postgres in schema app, private, xpms grant select on sequences to xos_backup;

-- 3. Files (storage) ---------------------------------------------------------------------------------------------------

-- buckets: migrations create each bucket, with its size limit and MIME types, as a row the schema dump leaves out.
-- objects: the list of stored files, their owners, paths and sizes, which app tables refer to. The files themselves stay
-- in Supabase Storage; the logical backup holds no file content.
grant usage on schema storage to xos_backup;
grant select on storage.buckets, storage.objects to xos_backup;

-- 4. Accounts (auth) ---------------------------------------------------------------------------------------------------

-- A restored project needs its people's accounts. postgres reads the auth tables but holds USAGE on auth without the
-- grant option, so no grant can reach them; a view would pin their columns and block Supabase Auth's own migrations.
-- This function reads them with its owner's rights and returns one INSERT per row, naming the stored columns so that a
-- column Supabase Auth adds later takes its default on restore. It reads only the tables that define an account:
--   * users: the account, its email, its password hash and its confirmation state; app.people points at it;
--   * identities: Supabase Auth signs a user in through an identity row, for email and for Google alike;
--   * mfa_factors: the second factors, TOTP secrets included. Without them an account that requires MFA would restore
--     with none, and whoever knows the password could enrol their own factor. The archive is encrypted to the owner's key;
--   * sso_providers, sso_domains, saml_providers: an org's SAML connection and the domains it signs in, without which its
--     people cannot sign in. They hold the identity provider's public metadata, no secret.
-- Left out: sessions, refresh_tokens, one_time_tokens, flow_state, mfa_challenges, mfa_amr_claims, saml_relay_states and
-- the audit log hold live sign-in state, one-time secrets or history a restore does not need (everyone signs in again
-- after a restore). For the same reason the users' one-time token columns (confirmation, recovery, email and phone
-- change, reauthentication) are written empty, which Supabase Auth reads as no token pending: a link sent before the
-- backup no longer works after a restore, and the person asks for a new one. Passkeys (webauthn_credentials), Supabase Auth's own recovery codes, the OAuth server's clients and
-- consents, SCIM and custom OAuth providers are left out too: Supabase's daily backups and PITR keep them.
create or replace function private.backup_account_rows()
returns setof text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_columns text;
  v_row jsonb;
  v_tokens constant text[] := array['confirmation_token', 'recovery_token', 'email_change_token_new',
    'email_change_token_current', 'phone_change_token', 'reauthentication_token'];
begin
  foreach v_table in array array['users', 'identities', 'mfa_factors', 'sso_providers', 'sso_domains', 'saml_providers'] loop
    -- Generated columns (users.confirmed_at, identities.email) are computed again on insert.
    select string_agg(pg_catalog.quote_ident(a.attname), ', ' order by a.attnum) into v_columns
    from pg_catalog.pg_attribute a
    where a.attrelid = pg_catalog.format('auth.%I', v_table)::regclass and a.attnum > 0 and not a.attisdropped
      and a.attgenerated = '';
    for v_row in execute pg_catalog.format('select pg_catalog.to_jsonb(t) from auth.%I t order by t.ctid', v_table) loop
      if v_table = 'users' then
        v_row := v_row || coalesce((select pg_catalog.jsonb_object_agg(k, '') from pg_catalog.unnest(v_tokens) k where v_row ? k), '{}');
      end if;
      return next pg_catalog.format('insert into auth.%1$I (%2$s) select %2$s from pg_catalog.jsonb_populate_record(null::auth.%1$I, %3$L);',
        v_table, v_columns, v_row);
    end loop;
  end loop;
end;
$$;

comment on function private.backup_account_rows() is 'Weekly backup only (migration 1650): the account tables of auth (users, identities, mfa_factors, sso_providers, sso_domains, saml_providers) as one INSERT per row, with the users'' one-time token columns empty, which infra/ci/backup-weekly.sh --reader appends to data.sql. Executable by xos_backup alone; never sessions, tokens, Vault or the audit log.';

revoke all on function private.backup_account_rows() from public, anon, authenticated, service_role;
grant execute on function private.backup_account_rows() to xos_backup;

-- 5. Worker schedules (pg_cron) ----------------------------------------------------------------------------------------

-- Migrations schedule the platform's workers as rows of cron.job, which the schema dump leaves out with the cron schema.
-- USAGE on cron would let the login call cron.schedule, which PUBLIC may execute, and so write a job. This function
-- reads the schedules with its owner's rights instead and returns them as cron.schedule calls (cron.sql), for a restored
-- project to run. The commands call worker functions and hold no secret.
create or replace function private.backup_cron_schedules()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.format('select cron.schedule(%L, %L, %L);', j.jobname, j.schedule, j.command)
    || case when j.active then ''
       else pg_catalog.format(E'\nselect cron.alter_job(c.jobid, active => false) from cron.job c where c.jobname = %L;', j.jobname) end
  from cron.job j
  where j.jobname is not null
  order by j.jobname;
$$;

comment on function private.backup_cron_schedules() is 'Weekly backup only (migration 1650): every named pg_cron job as a cron.schedule call, which infra/ci/backup-weekly.sh --reader writes to cron.sql so a restored project runs the same workers. Executable by xos_backup alone, which has no USAGE on cron.';

revoke all on function private.backup_cron_schedules() from public, anon, authenticated, service_role;
grant execute on function private.backup_cron_schedules() to xos_backup;

-- 6. Migration history ------------------------------------------------------------------------------------------------

-- The CLI records each applied migration in supabase_migrations.schema_migrations, which no dump includes (the CLI's own
-- leave it out too). Without it a restored project's migration check fails, and the next `supabase db push` would try
-- every migration again. This function returns the applied versions, written to migrations.txt, so the restore records
-- them again with `supabase migration repair --status applied` (infra/runbooks/backup-and-restore.md). Versions only:
-- each migration's text is in the repository. The table is read at call time, since a database built without the CLI
-- has none, and then the function returns nothing.
create or replace function private.backup_migration_versions()
returns setof text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null then
    return query execute 'select m.version from supabase_migrations.schema_migrations m order by m.version';
  end if;
end;
$$;

comment on function private.backup_migration_versions() is 'Weekly backup only (migration 1650): the versions in supabase_migrations.schema_migrations, which infra/ci/backup-weekly.sh --reader writes to migrations.txt so a restore can record the migration history again. Executable by xos_backup alone.';

revoke all on function private.backup_migration_versions() from public, anon, authenticated, service_role;
grant execute on function private.backup_migration_versions() to xos_backup;

-- 7. XOS's objects on Supabase's tables -------------------------------------------------------------------------------

-- Migrations put triggers on auth.users and storage.objects (a person for each new account, the age confirmation, the
-- upload scan queue), policies on storage.objects (who reads and writes each bucket) and the grants of section 3. The
-- schema dump leaves the auth and storage schemas out, and these with them, as the CLI's own dump does, so a project
-- restored without them would have no storage policies, no new person on sign-up and no scan queue. This function
-- returns them as SQL, written to platform.sql and run after data.sql, each statement replacing one of the same name:
--   * triggers on auth and storage tables whose function is in app, private or xpms (Supabase's own are left alone), as
--     CREATE OR REPLACE TRIGGER, which needs only the TRIGGER privilege the migrations used, with their enabled state;
--   * every policy on a storage table, dropped and created again: a new project has none, so all are XOS's;
--   * grants on the auth and storage schemas and tables to XOS's own roles (xos_*).
-- It reads only catalogs every role may read, so it runs with the caller's rights, not its owner's.
create or replace function private.backup_platform_objects()
returns setof text
language sql
stable
set search_path = ''
as $$
  select s from (
    select 1 as kind, c.oid::regclass::text as rel, t.tgname::text as name,
      pg_catalog.regexp_replace(pg_catalog.pg_get_triggerdef(t.oid), '^CREATE TRIGGER ', 'CREATE OR REPLACE TRIGGER ') || ';'
        || case t.tgenabled
             when 'D' then pg_catalog.format(E'\nalter table %s disable trigger %I;', c.oid::regclass, t.tgname)
             when 'R' then pg_catalog.format(E'\nalter table %s enable replica trigger %I;', c.oid::regclass, t.tgname)
             when 'A' then pg_catalog.format(E'\nalter table %s enable always trigger %I;', c.oid::regclass, t.tgname)
             else '' end as s
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_proc f on f.oid = t.tgfoid
    join pg_catalog.pg_namespace fn on fn.oid = f.pronamespace
    where n.nspname in ('auth', 'storage') and not t.tgisinternal and fn.nspname in ('app', 'private', 'xpms')
    union all
    select 2, c.oid::regclass::text, p.polname::text,
      pg_catalog.format('drop policy if exists %I on %s;', p.polname, c.oid::regclass) || E'\n'
        || pg_catalog.format('create policy %I on %s as %s for %s to %s', p.polname, c.oid::regclass,
             case when p.polpermissive then 'permissive' else 'restrictive' end,
             case p.polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' else 'all' end,
             (select pg_catalog.string_agg(case when r.oid = 0 then 'public' else r.oid::regrole::text end, ', ' order by r.ord)
              from pg_catalog.unnest(p.polroles) with ordinality r(oid, ord)))
        || coalesce(' using (' || pg_catalog.pg_get_expr(p.polqual, p.polrelid) || ')', '')
        || coalesce(' with check (' || pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) || ')', '') || ';'
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage'
    union all
    select 3, n.nspname::text, r.rolname::text || ' ' || a.privilege_type,
      pg_catalog.format('grant %s on schema %I to %I;', a.privilege_type, n.nspname, r.rolname)
    from pg_catalog.pg_namespace n
    cross join lateral pg_catalog.aclexplode(n.nspacl) a
    join pg_catalog.pg_roles r on r.oid = a.grantee
    where n.nspname in ('auth', 'storage') and r.rolname like 'xos\_%'
    union all
    select 4, c.oid::regclass::text, r.rolname::text || ' ' || a.privilege_type,
      pg_catalog.format('grant %s on table %s to %I;', a.privilege_type, c.oid::regclass, r.rolname)
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(c.relacl) a
    join pg_catalog.pg_roles r on r.oid = a.grantee
    where n.nspname in ('auth', 'storage') and r.rolname like 'xos\_%'
  ) o
  order by o.kind, o.rel, o.name;
$$;

comment on function private.backup_platform_objects() is 'Weekly backup only (migration 1650): XOS''s triggers on auth and storage tables, its policies on storage tables and its grants on those schemas and tables to xos_* roles, as SQL that replaces each by name. infra/ci/backup-weekly.sh --reader writes it to platform.sql, which a restore runs after data.sql. Reads catalogs only, with the caller''s rights; executable by xos_backup alone.';

revoke all on function private.backup_platform_objects() from public, anon, authenticated, service_role;
grant execute on function private.backup_platform_objects() to xos_backup;

-- Vault: no grant at all. The secrets are encrypted with the project's own key, so a restore re-creates them from the
-- owner's secret store (infra/runbooks/backup-and-restore.md).
