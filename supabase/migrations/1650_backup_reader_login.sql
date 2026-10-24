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
--     grant USAGE on auth, and USAGE on cron would let the login schedule jobs;
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

comment on role xos_backup is 'Weekly production backup login (ADR 0033, decision 47; migration 1650): reads the application schemas, the storage object list, and the accounts and worker schedules through private.backup_account_rows and private.backup_cron_schedules; writes nothing. Its password is set by the owner, never in a migration.';

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
-- after a restore). Passkeys (webauthn_credentials), Supabase Auth's own recovery codes, the OAuth server's clients and
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
begin
  foreach v_table in array array['users', 'identities', 'mfa_factors', 'sso_providers', 'sso_domains', 'saml_providers'] loop
    -- Generated columns (users.confirmed_at, identities.email) are computed again on insert.
    select string_agg(pg_catalog.quote_ident(a.attname), ', ' order by a.attnum) into v_columns
    from pg_catalog.pg_attribute a
    where a.attrelid = pg_catalog.format('auth.%I', v_table)::regclass and a.attnum > 0 and not a.attisdropped
      and a.attgenerated = '';
    for v_row in execute pg_catalog.format('select pg_catalog.to_jsonb(t) from auth.%I t order by t.ctid', v_table) loop
      return next pg_catalog.format('insert into auth.%1$I (%2$s) select %2$s from pg_catalog.jsonb_populate_record(null::auth.%1$I, %3$L);',
        v_table, v_columns, v_row);
    end loop;
  end loop;
end;
$$;

comment on function private.backup_account_rows() is 'Weekly backup only (migration 1650): the account tables of auth (users, identities, mfa_factors, sso_providers, sso_domains, saml_providers) as one INSERT per row, which infra/ci/backup-weekly.sh --reader appends to data.sql. Executable by xos_backup alone; never sessions, tokens, Vault or the audit log.';

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

-- Vault: no grant at all. The secrets are encrypted with the project's own key, so a restore re-creates them from the
-- owner's secret store (infra/runbooks/backup-and-restore.md).
