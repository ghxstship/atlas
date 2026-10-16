-- Security finding A22-001 (regression): the database applies an API key's scopes. A token minted
-- by api-token (amr method xos_api_key) reaches only the capability groups in its scopes, so sending
-- it straight to PostgREST cannot exceed the key. Sessions not minted for a key are unaffected.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(7);

-- Bob (Admin of Northwind Live) creates an Admin service account and a key scoped to crew only.
select pg_temp.as_user('bob');
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
  'a crew-scoped key token cannot rename the organization (org scope)');

select throws_ok(
  format($$select app.create_invite_link(%L, %L, interval '1 day', 5)$$, pg_temp.id('org_a'), pg_temp.system_role('member')),
  '42501', null,
  'a crew-scoped key token cannot mint invitation links (org scope)');

select is(
  (select count(*)::integer from app.api_keys where org_id = pg_temp.id('org_a')),
  0,
  'a crew-scoped key token cannot list the org''s API keys (org scope)');

-- An empty scope list permits nothing; an ordinary session (no amr) keeps the role's full reach.
select pg_temp.as_minted_token(array[]::text[]);
select isnt(pg_temp.touched(format($$update app.organizations set name = name where id = %L$$, pg_temp.id('org_a'))), '1',
  'a key token with no scopes cannot edit the organization');

select pg_temp.as_platform();
select is(private.api_key_scopes(), null::text[], 'a session not minted for a key has no key scopes');

select pg_temp.as_user('bob');
select is(pg_temp.touched(format($$update app.organizations set name = name where id = %L$$, pg_temp.id('org_a'))), '1',
  'an Admin''s own session is not limited by key scopes');

select * from finish();
rollback;
