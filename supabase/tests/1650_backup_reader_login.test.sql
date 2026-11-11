-- pgTAP: migration 1650, the weekly production backup's read-only login (ADR 0033, decision 47; RRR-139). xos_backup
-- logs in, bypasses row security as pg_dump needs, and reads every table and sequence of app, private and xpms, now and
-- later, and the storage buckets and object list. It reaches the accounts, the worker schedules and the migration
-- versions only through private.backup_account_rows, private.backup_cron_schedules and
-- private.backup_migration_versions, and the account rows restore exactly, but for their one-time tokens, which come
-- back empty. private.backup_platform_objects gives back XOS's triggers, policies and grants on auth and storage
-- exactly. It holds no membership, writes nothing, executes no other owner-rights function, and reads nothing in Vault
-- or auth.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(41);

select pg_temp.as_platform();

-- Acting as the login inside this transaction needs the SET option on it; a superuser session has it already. pgTAP
-- lives in extensions, which the login may not use, so each statement runs as the login inside a helper: it returns
-- 'ok' or the SQLSTATE it failed with, and a count when asked. Row security is off, as pg_dump runs.
do $$
begin
  if not pg_has_role(session_user, 'xos_backup', 'SET') then
    execute format('grant xos_backup to %I with inherit false, set true', session_user);
  end if;
end;
$$;

create function pg_temp.as_backup(p_sql text) returns text
language plpgsql as $$
declare
  v_state text := 'ok';
begin
  perform set_config('role', 'xos_backup', true);
  perform set_config('row_security', 'off', true);
  begin
    execute p_sql;
  exception when others then
    v_state := sqlstate;
  end;
  perform set_config('row_security', 'on', true);
  perform set_config('role', 'postgres', true);
  return v_state;
end $$;

create function pg_temp.count_as_backup(p_sql text) returns bigint
language plpgsql as $$
declare
  v_count bigint;
begin
  perform set_config('role', 'xos_backup', true);
  perform set_config('row_security', 'off', true);
  execute p_sql into v_count;
  perform set_config('row_security', 'on', true);
  perform set_config('role', 'postgres', true);
  return v_count;
end $$;

-- Views the login can read, with each relation in vault or auth they read, followed through other views.
create function pg_temp.views_reaching_secrets() returns setof text
language sql stable as $$
  with recursive reach(view_oid, rel_oid) as (
    select v.oid, d.refobjid
    from pg_class v
    join pg_rewrite r on r.ev_class = v.oid
    join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = r.oid and d.refclassid = 'pg_class'::regclass
    where v.relkind in ('v', 'm') and d.refobjid <> v.oid and has_table_privilege('xos_backup', v.oid, 'SELECT')
    union
    select reach.view_oid, d.refobjid
    from reach
    join pg_class c on c.oid = reach.rel_oid and c.relkind in ('v', 'm')
    join pg_rewrite r on r.ev_class = c.oid
    join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = r.oid and d.refclassid = 'pg_class'::regclass
    where d.refobjid <> c.oid
  )
  select distinct reach.view_oid::regclass::text || ' reads ' || reach.rel_oid::regclass::text
  from reach join pg_class t on t.oid = reach.rel_oid join pg_namespace n on n.oid = t.relnamespace
  where n.nspname in ('vault', 'auth')
$$;

-- The account tables as one text per table, to compare before and after a restore; the users' one-time tokens, which
-- the backup leaves out, apart.
create function pg_temp.accounts_digest() returns text
language sql stable as $$
  select string_agg(t.digest, ' ' order by t.name) from (
    select 'users' as name, md5(coalesce(string_agg((to_jsonb(x) - array['confirmation_token', 'recovery_token',
      'email_change_token_new', 'email_change_token_current', 'phone_change_token', 'reauthentication_token'])::text,
      '|' order by x.id), '')) as digest from auth.users x
    union all select 'identities', md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from auth.identities x
    union all select 'mfa_factors', md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from auth.mfa_factors x
    union all select 'sso_providers', md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from auth.sso_providers x
    union all select 'sso_domains', md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from auth.sso_domains x
    union all select 'saml_providers', md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from auth.saml_providers x
  ) t
$$;

-- 1. The role ----------------------------------------------------------------------------------------------------------

select results_eq(
  $$select rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit, rolconnlimit
    from pg_roles where rolname = 'xos_backup'$$,
  $$values (true, false, false, false, false, true, false, 2)$$,
  'xos_backup logs in and bypasses row security, and is no superuser, creates no role or database, never replicates');

select ok(
  exists (select 1 from pg_db_role_setting s
          where s.setrole = 'xos_backup'::regrole and s.setdatabase = 0
            and 'default_transaction_read_only=on' = any(s.setconfig)),
  'every session of the login starts read-only');

select is_empty(
  $$select r.rolname::text from pg_auth_members m join pg_roles r on r.oid = m.roleid
    where m.member = 'xos_backup'::regrole$$,
  'the login is a member of no role');

-- 2. What it may read --------------------------------------------------------------------------------------------------

select set_eq(
  $$select n.nspname::text from pg_namespace n
    where has_schema_privilege('xos_backup', n.oid, 'USAGE') and not has_schema_privilege('public', n.oid, 'USAGE')$$,
  $$values ('app'), ('private'), ('xpms'), ('storage')$$,
  'beyond what every role has, the login uses app, private, xpms and storage only: not auth, cron, vault or extensions');

select is_empty(
  $$select c.oid::regclass::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('app', 'private', 'xpms') and c.relkind in ('r', 'p', 'S')
      and not has_table_privilege('xos_backup', c.oid, 'SELECT')$$,
  'every table and sequence in app, private and xpms is readable, for pg_dump''s locks, rows and sequence values');

select set_eq(
  $$select c.oid::regclass::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname not in ('app', 'private', 'xpms') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and has_table_privilege('xos_backup', c.oid, 'SELECT') and not has_table_privilege('public', c.oid, 'SELECT')$$,
  $$values ('storage.buckets'), ('storage.objects')$$,
  'outside the application schemas the login reads only the storage buckets and object list');

select is_empty(
  $$select c.oid::regclass::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('vault', 'auth') and has_table_privilege('xos_backup', c.oid, 'SELECT')$$,
  'no table or view in vault or auth is readable: no secret, session or token');

select is_empty(
  $$select c.oid::regclass::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('app', 'private', 'xpms') and c.relkind in ('v', 'm')
      and has_table_privilege('xos_backup', c.oid, 'SELECT')$$,
  'no existing view is granted: pg_dump never reads a view''s rows');

select is_empty('select * from pg_temp.views_reaching_secrets()',
  'no view the login can read reaches vault or auth, directly or through another view');

-- 3. What it may not do ------------------------------------------------------------------------------------------------

select is_empty(
  $$select table_schema || '.' || table_name || ' ' || privilege_type from information_schema.role_table_grants
    where grantee = 'xos_backup' and privilege_type <> 'SELECT'$$,
  'the login holds no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER grant');

select is_empty(
  $$select c.oid::regclass::text from pg_class c
    where c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_table_privilege('xos_backup', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      and not has_table_privilege('public', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')$$,
  'beyond what every role has, the login may change no table anywhere');

select is_empty(
  $$select n.nspname::text from pg_namespace n
    where has_schema_privilege('xos_backup', n.oid, 'CREATE') and n.nspname !~ '^pg_(toast_)?temp_'$$,
  'the login creates nothing in any schema but its own session''s temporary one');

select ok(not has_database_privilege('xos_backup', current_database(), 'CREATE'),
  'the login creates no schema');

select set_eq(
  $$select p.oid::regprocedure::text from pg_proc p
    where p.prosecdef and has_function_privilege('xos_backup', p.oid, 'EXECUTE')
      and has_schema_privilege('xos_backup', p.pronamespace, 'USAGE')$$,
  $$values ('private.backup_account_rows()'), ('private.backup_cron_schedules()'), ('private.backup_migration_versions()')$$,
  'the only owner-rights functions the login may run are the three backup readers');

select is_empty(
  $$select r.rolname::text from pg_roles r
    where r.rolname <> 'xos_backup' and not r.rolsuper and r.rolname <> 'postgres'
      and (has_function_privilege(r.oid, 'private.backup_account_rows()', 'EXECUTE')
        or has_function_privilege(r.oid, 'private.backup_cron_schedules()', 'EXECUTE')
        or has_function_privilege(r.oid, 'private.backup_migration_versions()', 'EXECUTE')
        or has_function_privilege(r.oid, 'private.backup_platform_objects()', 'EXECUTE'))$$,
  'no other role, anon, authenticated and service_role included, may run the backup readers');

-- 4. Later migrations --------------------------------------------------------------------------------------------------

create table app.zz_backup_probe (id bigint generated always as identity primary key);
create view app.zz_backup_probe_accounts as select u.id from auth.users u;

select ok(has_table_privilege('xos_backup', 'app.zz_backup_probe', 'SELECT')
       and has_sequence_privilege('xos_backup', 'app.zz_backup_probe_id_seq', 'SELECT'),
  'a table and sequence a later migration creates are readable at once, so the weekly backup keeps working');

select is(
  (select string_agg(v, ', ') from pg_temp.views_reaching_secrets() v),
  'app.zz_backup_probe_accounts reads auth.users',
  'a later view over auth that the login could read is caught: revoke SELECT on it from xos_backup');

drop view app.zz_backup_probe_accounts;
drop table app.zz_backup_probe;

-- 5. As the login ------------------------------------------------------------------------------------------------------

create temporary table cron_rows (s text);
create temporary table account_rows (s text);
create temporary table migration_rows (s text);
create temporary table platform_rows (s text);
grant select, insert on cron_rows, account_rows, migration_rows, platform_rows to public;

select is(pg_temp.count_as_backup('select count(*) from app.organizations'), (select count(*) from app.organizations),
  'with row security off, as pg_dump runs, the login reads every row of a table under policies');

select is(pg_temp.count_as_backup('select count(*) from app.people'), (select count(*) from app.people),
  'not only the rows its own claims would show');

select is(pg_temp.as_backup('select count(*) from storage.objects'), 'ok', 'the login reads the storage object list');

select is(pg_temp.as_backup('update app.organizations set name = name'), '42501', 'the login changes no application row');

select is(pg_temp.as_backup('delete from storage.objects'), '42501', 'nor any storage row');

select is(pg_temp.as_backup('select count(*) from vault.secrets'), '42501', 'the login reads no Vault secret');

select is(pg_temp.as_backup('select count(*) from auth.users'), '42501', 'nor any auth table directly');

select is(pg_temp.as_backup($$select cron.schedule('zz_backup_probe', '0 0 1 1 *', 'select 1')$$), '42501',
  'and schedules no job: it has no USAGE on cron');

select is(pg_temp.as_backup($$select app.receive_inbound_email('x', 'a@b.test', 's', '<m@b.test>', true, 't', 'raw/x.eml')$$),
  '42501', 'an owner-rights RPC that writes is refused');

select is(pg_temp.as_backup('insert into pg_temp.cron_rows select s from private.backup_cron_schedules() s'), 'ok',
  'the login reads the worker schedules through private.backup_cron_schedules');

select ok(
  (select count(*) from cron_rows) = (select count(*) from cron.job where jobname is not null)
    and (select bool_and(s like 'select cron.schedule(%') from cron_rows),
  'as one cron.schedule call per named job');

select ok(
  exists (select 1 from cron_rows where s = format('select cron.schedule(%L, %L, %L);', 'xos_nightly_retention', '17 3 * * *',
    'select private.run_nightly_retention()')),
  'with the job''s name, schedule and command');

select is(pg_temp.as_backup('insert into pg_temp.migration_rows select s from private.backup_migration_versions() s'), 'ok',
  'the login reads the migration versions through private.backup_migration_versions');

select ok(
  (select array_agg(s order by s) from migration_rows)
    = (select array_agg(m.version order by m.version) from supabase_migrations.schema_migrations m)
    and exists (select 1 from migration_rows where s = '1650'),
  'every applied version, this one included, so a restore can record the migration history again');

-- 6. The accounts round-trip --------------------------------------------------------------------------------------------

-- One account of every kind the function reads: a user with an email identity and a TOTP factor, and an org's SAML
-- connection with its domain.
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
select pg_temp.id('alice_user')::text, pg_temp.id('alice_user'),
  jsonb_build_object('sub', pg_temp.id('alice_user')::text, 'email', 'alice@northwind.test'), 'email', now(), now();
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001650', pg_temp.id('alice_user'), 'Phone', 'totp', 'verified',
  'JBSWY3DPEHPK3PXP', now(), now());
insert into auth.sso_providers (id, resource_id, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001651', 'northwind-okta', now(), now());
insert into auth.sso_domains (id, sso_provider_id, domain, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001652', '00000000-0000-4000-8000-000000001651', 'northwind.test', now(), now());
insert into auth.saml_providers (id, sso_provider_id, entity_id, metadata_xml, attribute_mapping, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001653', '00000000-0000-4000-8000-000000001651', 'https://idp.northwind.test',
  '<EntityDescriptor entityID="https://idp.northwind.test"/>', '{"keys": {}}', now(), now());
-- Alice has a link of every kind outstanding.
update auth.users set confirmation_token = 'tok1650confirm', recovery_token = 'tok1650recover',
  email_change_token_new = 'tok1650emailnew', email_change_token_current = 'tok1650emailcur',
  phone_change_token = 'tok1650phone', reauthentication_token = 'tok1650reauth'
where id = pg_temp.id('alice_user');

create temporary table digest_before as select pg_temp.accounts_digest() as d;

select is(pg_temp.as_backup('insert into pg_temp.account_rows select s from private.backup_account_rows() s'), 'ok',
  'the login reads the accounts through private.backup_account_rows');

select ok(
  (select count(*) from account_rows) = (select count(*) from auth.users) + (select count(*) from auth.identities)
    + (select count(*) from auth.mfa_factors) + (select count(*) from auth.sso_providers)
    + (select count(*) from auth.sso_domains) + (select count(*) from auth.saml_providers),
  'one INSERT per row of users, identities, mfa_factors, sso_providers, sso_domains and saml_providers');

select is_empty(
  $$select left(s, 80) from account_rows
    where s !~ '^insert into auth\.(users|identities|mfa_factors|sso_providers|sso_domains|saml_providers) \('
       or (s like 'insert into auth.users %' and split_part(s, ')', 1) ~ '\mconfirmed_at\M')
       or (s like 'insert into auth.identities %' and split_part(s, ')', 1) ~ '\memail\M')$$,
  'none touches another auth table or sets a generated column (users.confirmed_at, identities.email)');

select is_empty($$select left(s, 80) from account_rows where s ~ 'tok1650'$$,
  'no INSERT carries a one-time token');

-- Restore them into emptied tables, as data.sql does with triggers off, and compare every row.
set local session_replication_role = replica;
delete from auth.saml_providers;
delete from auth.sso_domains;
delete from auth.sso_providers;
delete from auth.mfa_factors;
delete from auth.identities;
delete from auth.users;

do $$
declare
  v_statement text;
begin
  for v_statement in select s from account_rows loop
    execute v_statement;
  end loop;
end;
$$;
set local session_replication_role = origin;

select is(pg_temp.accounts_digest(), (select d from digest_before),
  'the INSERTs restore every account row exactly, generated columns recomputed');

select is_empty(
  $$select id::text from auth.users
    where concat(confirmation_token, recovery_token, email_change_token_new, email_change_token_current,
      phone_change_token, reauthentication_token) <> ''
       or confirmation_token is null or recovery_token is null$$,
  'every one-time token comes back empty, not null, which Supabase Auth reads as no link pending');

-- 7. XOS's objects on auth and storage --------------------------------------------------------------------------------

-- Every trigger, policy and grant the function covers, as the catalogs describe them.
create function pg_temp.platform_digest() returns text
language sql stable as $$
  select string_agg(x, E'\n' order by x) from (
    select pg_get_triggerdef(t.oid) || ' ' || t.tgenabled::text as x
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_proc f on f.oid = t.tgfoid join pg_namespace fn on fn.oid = f.pronamespace
    where n.nspname in ('auth', 'storage') and not t.tgisinternal and fn.nspname in ('app', 'private', 'xpms')
    union all
    select concat_ws(' | ', tablename, policyname, permissive, roles::text, cmd, qual, with_check) from pg_policies where schemaname = 'storage'
    union all
    select concat_ws(' | ', 'grants', has_schema_privilege('xos_backup', 'storage', 'USAGE'),
      has_table_privilege('xos_backup', 'storage.buckets', 'SELECT'), has_table_privilege('xos_backup', 'storage.objects', 'SELECT'))
  ) d
$$;

create function pg_temp.run_platform_rows() returns void
language plpgsql as $$
declare
  v_statement text;
begin
  for v_statement in select s from platform_rows loop
    execute v_statement;
  end loop;
end $$;

create temporary table platform_before as select pg_temp.platform_digest() as d;

select is(pg_temp.as_backup('insert into pg_temp.platform_rows select s from private.backup_platform_objects() s'), 'ok',
  'the login reads XOS''s triggers, policies and grants on auth and storage through private.backup_platform_objects');

select ok(
  exists (select 1 from platform_rows where s like 'CREATE OR REPLACE TRIGGER xos_create_person AFTER INSERT ON auth.users %')
    and exists (select 1 from platform_rows where s like 'CREATE OR REPLACE TRIGGER t90_queue_object_scan AFTER INSERT OR UPDATE ON storage.objects %')
    and (select count(*) from platform_rows where s like 'drop policy if exists %') = (select count(*) from pg_policies where schemaname = 'storage')
    and (select count(*) from platform_rows where s like 'grant % to xos_backup;') = 3,
  'one statement per XOS trigger on auth.users and storage.objects, per storage policy, and per grant of section 3');

select pg_temp.run_platform_rows();
select is(pg_temp.platform_digest(), (select d from platform_before),
  'run over the live objects, each statement replaces its own by name and changes nothing');

-- A project restored from the schema dump has none of them. Each DROP POLICY IF EXISTS then notes that it found none.
set local client_min_messages = warning;
do $$
declare
  v record;
begin
  for v in
    select t.tgname, t.tgrelid::regclass as rel, t.tgfoid::regproc as fn
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_proc f on f.oid = t.tgfoid join pg_namespace fn on fn.oid = f.pronamespace
    where n.nspname in ('auth', 'storage') and not t.tgisinternal and fn.nspname in ('app', 'private', 'xpms')
  loop
    begin
      execute format('drop trigger %I on %s', v.tgname, v.rel);
    exception when insufficient_privilege then
      -- postgres may drop triggers only on the tables supautils.drop_trigger_grants lists, which leaves out
      -- auth.webauthn_credentials (2050's passkey notice). Such a trigger is put out of shape by name instead, so
      -- platform.sql must still give it back exactly.
      execute format('create or replace trigger %I after truncate on %s for each statement execute function %s()',
        v.tgname, v.rel, v.fn);
    end;
  end loop;
  for v in select policyname, format('%I.%I', schemaname, tablename) as rel from pg_policies where schemaname = 'storage' loop
    execute format('drop policy %I on %s', v.policyname, v.rel);
  end loop;
  revoke select on storage.buckets, storage.objects from xos_backup;
  revoke usage on schema storage from xos_backup;
end;
$$;

select pg_temp.run_platform_rows();
select is(pg_temp.platform_digest(), (select d from platform_before),
  'platform.sql gives a restored project back every trigger, storage policy and grant exactly');

select * from finish();
rollback;
