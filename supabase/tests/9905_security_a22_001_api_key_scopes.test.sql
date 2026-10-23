-- A22-001 (High): an API key's scopes are enforced only in the Hono runtime, never in the database.
-- The api-token Edge Function returns the minted JWT to whoever presents the key, and that JWT is a
-- valid Supabase session for the service account. Sent straight to PostgREST, it acts with the
-- service account's full role, whatever the key's scopes say.
--
-- Regression test from the attacker's side: fixed in migration 0936 (RRR-41). This file failed on
-- main d36918a and must keep passing.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(4);

-- Bob (Admin of Northwind Live) creates an Admin service account and a key scoped to crew only, with step-up (1562).
select pg_temp.as_user_stepped_up('bob');
insert into world select 'sa_admin', app.create_service_account(pg_temp.id('org_a'), 'Crew Sync Bot', pg_temp.system_role('admin'));
create temporary table crew_key as
  select * from app.create_api_key(pg_temp.id('org_a'), 'Crew Only Key', array['crew'], now() + interval '30 days', pg_temp.id('sa_admin'));
grant select on crew_key to public;
select pg_temp.as_platform();
insert into world select 'sa_admin_user', s.user_id from app.service_accounts s where s.id = pg_temp.id('sa_admin');

-- What the api-token function signs for this key (supabase/functions/api-token/mint.ts tokenClaims).
create function pg_temp.as_minted_token(p_scopes text[]) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', json_build_object(
    'sub', pg_temp.id('sa_admin_user'), 'role', 'authenticated', 'aud', 'authenticated',
    'org_id', pg_temp.id('org_a'), 'scopes', p_scopes,
    'amr', json_build_array(json_build_object('method', 'xos_api_key', 'timestamp', 0)))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- Rows a statement touched, or the SQLSTATE that refused it.
create function pg_temp.touched(p_sql text) returns text
language plpgsql as $$
declare
  v_rows bigint;
begin
  execute p_sql;
  get diagnostics v_rows = row_count;
  return v_rows::text;
exception when others then
  return sqlstate;
end $$;

-- Control: the same statements succeed for a token with the org scope, so each refusal below is
-- about the scope and nothing else.
select pg_temp.as_minted_token(array['org']);
select is(pg_temp.touched(format($$update app.organizations set name = name where id = %L$$, pg_temp.id('org_a'))), '1',
  'control: the service account itself may edit the organization');

select pg_temp.as_minted_token(array['crew']);

select isnt(pg_temp.touched(format($$update app.organizations set name = 'Renamed By Crew Key' where id = %L$$, pg_temp.id('org_a'))), '1',
  'A22-001: a crew-scoped key token cannot rename the organization (org scope)');

select throws_ok(
  format($$select app.create_invite_link(%L, %L, interval '1 day', 5)$$, pg_temp.id('org_a'), pg_temp.system_role('member')),
  '42501', null,
  'A22-001: a crew-scoped key token cannot mint invitation links (org scope)');

select is(
  (select count(*)::integer from app.api_keys where org_id = pg_temp.id('org_a')),
  0,
  'A22-001: a crew-scoped key token cannot list the org''s API keys (org scope)');

select * from finish();
rollback;
