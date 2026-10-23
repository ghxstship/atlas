-- pgTAP: migration 1563, OAuth 2.1 on Supabase Auth's OAuth server (A99, RRR-144; A65-002, trace rows S8.5-02 and
-- S10.1-02, ADR 0055). A registered app becomes a public PKCE client in Supabase Auth and follows the app's changes; the
-- capability groups an authorization asks for are recorded for the member who started it; consent needs PKCE with S256
-- and step-up for Restricted groups; an app's session is scoped to its live grant and to the org that registered the
-- app, and its token names that org; revoking a grant revokes Supabase Auth's consent and ends the app's sessions.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(41);

create function pg_temp.as_session(p_user text, p_aal text, p_second_ago interval, p_client uuid default null) returns void
language plpgsql as $$
declare
  v_amr jsonb := jsonb_build_array(jsonb_build_object('method',
    case when p_client is null then 'password' else 'oauth_provider/authorization_code' end,
    'timestamp', extract(epoch from now() - interval '1 hour')::bigint));
begin
  if p_second_ago is not null then
    v_amr := jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - p_second_ago)::bigint)) || v_amr;
  end if;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    jsonb_strip_nulls(jsonb_build_object('sub', pg_temp.id(p_user || '_user'), 'role', 'authenticated', 'aal', p_aal,
      'session_id', gen_random_uuid(), 'amr', v_amr, 'client_id', p_client, 'scope', case when p_client is not null then 'email' end))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create temporary table authorizations (key text primary key, authorization_id text not null);
grant select, insert on authorizations to public;

-- A pending Supabase Auth authorization for the app's client, as /auth/v1/oauth/authorize leaves it.
create function pg_temp.authorization(p_key text, p_method text) returns text
language plpgsql as $$
declare
  v_id text := substr(md5(random()::text) || md5(random()::text), 1, 32);
begin
  perform set_config('role', 'postgres', true);
  insert into auth.oauth_authorizations (id, authorization_id, client_id, redirect_uri, scope, code_challenge, code_challenge_method)
  values (gen_random_uuid(), v_id, pg_temp.id('client'), 'https://ledger.example.test/callback', 'email',
    repeat('a', 43), p_method::auth.code_challenge_method);
  insert into authorizations values (p_key, v_id);
  return v_id;
end $$;

create function pg_temp.auth_id(p_key text) returns text
language sql stable as $$ select a.authorization_id from authorizations a where a.key = p_key $$;


-- Registering an app makes its Supabase Auth client -----------------------------------------------------------------------

select pg_temp.as_user('bob');
insert into app.oauth_apps (org_id, name, redirect_uri)
values (pg_temp.id('org_a'), 'Ledger Sync', 'https://ledger.example.test/callback');
select pg_temp.as_platform();
insert into world select 'app', a.id from app.oauth_apps a where a.name = 'Ledger Sync' and a.org_id = pg_temp.id('org_a');
insert into world select 'client', c.auth_client_id from private.oauth_app_clients c where c.oauth_app_id = pg_temp.id('app');

select isnt(pg_temp.id('client'), null, 'a registered app gets a Supabase Auth client');
select results_eq($$select client_type::text, client_secret_hash, token_endpoint_auth_method, grant_types, redirect_uris, client_name
  from auth.oauth_clients where id = (select id from world where key = 'client')$$,
  $$values ('public'::text, ''::text, 'none'::text, 'authorization_code,refresh_token'::text, 'https://ledger.example.test/callback'::text, 'Ledger Sync'::text)$$,
  'a public PKCE client with no secret, the app''s redirect URI and name');
select ok((select relrowsecurity from pg_class where oid = 'private.oauth_app_clients'::regclass)
  and (select relrowsecurity from pg_class where oid = 'private.oauth_requests'::regclass), 'the private tables have row level security');

select pg_temp.as_user('bob');
update app.oauth_apps set name = 'Ledger Sync Two', redirect_uri = 'https://ledger.example.test/callback' where id = pg_temp.id('app');
select pg_temp.as_platform();
select is((select client_name from auth.oauth_clients where id = pg_temp.id('client')), 'Ledger Sync Two', 'renaming the app renames the client');
create temporary table app_client as select client_id from app.oauth_apps where id = pg_temp.id('app');
grant select on app_client to public;

-- Recording what an authorization asks for -------------------------------------------------------------------------------

select pg_temp.authorization('plain', 'plain');
select pg_temp.authorization('s256', 's256');
select pg_temp.authorization('restricted', 's256');
select pg_temp.authorization('bad', 's256');

select pg_temp.as_session('dave', 'aal1', null);
select lives_ok($$select app.record_oauth_request(pg_temp.auth_id('s256'), array['work', 'Projects', 'work'])$$,
  'a member records the groups the app asks for');
select pg_temp.as_platform();
select is((select scopes from private.oauth_requests where authorization_id = pg_temp.auth_id('s256')), 'projects work',
  'sorted, distinct and space-separated');
select pg_temp.as_session('dave', 'aal1', null);
select throws_ok($$select app.record_oauth_request(pg_temp.auth_id('s256'), array['work'])$$, 'XR001',
  'oauth_request_recorded: This sign-in request was already started.', 'an authorization is recorded once');
select throws_ok($$select app.record_oauth_request(pg_temp.auth_id('bad'), array['payroll'])$$, 'XR001',
  'oauth_scope_unknown: payroll is not a capability group.', 'only capability groups');
select throws_ok($$select app.record_oauth_request('nosuchauthorization', array['work'])$$, 'XR001',
  'oauth_request_expired: This sign-in request has expired. Start again from the app.', 'an unknown authorization is refused');
select lives_ok($$select app.record_oauth_request(pg_temp.auth_id('plain'), array['work'])$$, 'a plain-PKCE request is recorded');
select lives_ok($$select app.record_oauth_request(pg_temp.auth_id('restricted'), array['data', 'work'])$$, 'and one asking for Restricted data');
select pg_temp.as_session('xavier', 'aal1', null);
select throws_ok($$select app.record_oauth_request(pg_temp.auth_id('bad'), array['work'])$$, 'XR001',
  'oauth_not_member: Only members of the org that registered the app can consent to it.', 'a non-member cannot');

-- The consent page --------------------------------------------------------------------------------------------------------

select pg_temp.as_session('dave', 'aal1', null);
select results_eq($$select app_name, org_name, scopes, restricted_scopes, pkce_s256 from app.oauth_consent_request(pg_temp.auth_id('s256'))$$,
  $$values ('Ledger Sync Two'::text, 'Northwind Live'::text, array['projects', 'work']::text[], '{}'::text[], true)$$,
  'the page shows the app, its org, the groups and that PKCE used S256');
select is((select restricted_scopes from app.oauth_consent_request(pg_temp.auth_id('restricted'))), array['data']::text[],
  'data is Restricted');
select set_config('role', 'postgres', true);
select ok(private.oauth_scope_restricted('org') and private.oauth_scope_restricted('audit') and not private.oauth_scope_restricted('work'),
  'so are org and audit; work is not');
select pg_temp.as_session('carol', 'aal1', null);
select is((select count(*)::int from app.oauth_consent_request(pg_temp.auth_id('s256'))), 0, 'only the member who started it sees it');

select pg_temp.as_session('dave', 'aal1', null);
select throws_ok($$select app.consent_oauth_request(pg_temp.auth_id('plain'))$$, 'XR001',
  'oauth_pkce_required: This app must use PKCE with S256. Ask its developer to update it.', 'consent needs PKCE with S256');
select throws_ok($$select app.consent_oauth_request(pg_temp.auth_id('restricted'))$$, 'XR001',
  'step_up_required: Confirm it is you with your second factor to let Ledger Sync Two use Restricted data.',
  'Restricted groups need step-up on consent');
select lives_ok($$select app.consent_oauth_request(pg_temp.auth_id('s256'))$$, 'consent to work and projects needs no step-up');
select pg_temp.as_platform();
select results_eq($$select scopes from app.oauth_grants where oauth_app_id = (select id from world where key = 'app') and deleted_at is null$$,
  $$values (array['projects', 'work']::text[])$$, 'the grant holds the groups consented to');
select is((select count(*)::int from private.oauth_requests where authorization_id = pg_temp.auth_id('s256')), 0, 'the request is used up');

-- An app's session -------------------------------------------------------------------------------------------------------

-- mia belongs to Northwind Live and to Harbor Lights.
select pg_temp.as_platform();
insert into app.oauth_grants (oauth_app_id, person_id, scopes) values (pg_temp.id('app'), pg_temp.id('mia'), array['org', 'projects']);
select pg_temp.as_session('mia', 'aal1', null, pg_temp.id('client'));
select set_config('role', 'postgres', true);
select is(private.api_key_scopes(), array['org', 'projects']::text[], 'an app''s session is scoped to the live grant');
select results_eq($$select org_id from app.my_oauth_access()$$, $$values ((select id from world where key = 'org_a'))$$,
  'and bound to the org that registered the app');
select results_eq($$select private.my_org_ids()$$, $$values ((select id from world where key = 'org_a'))$$,
  'it reaches only that org, though mia also belongs to Harbor Lights');
select ok(private.has_capability(pg_temp.id('org_a'), 'projects.project.read'), 'a granted group works in the app''s org');
select ok(not private.has_capability(pg_temp.id('org_a'), 'schedule.timeline.read'),
  'a group outside the grant does not, though mia''s role holds it');
select ok(not private.has_capability(pg_temp.id('org_b'), 'projects.project.read'),
  'nor does any other org, though her Harbor Lights role holds it');
select set_config('role', 'authenticated', true);
select throws_ok($$select app.grant_oauth_consent((select client_id from app_client), array['data'])$$,
  'XR001', 'step_up_session_only: Consent comes from the person''s own session, never an API key or an app.',
  'an app never consents for the person');
select is((select mfa_required or session_expired or session_ended from app.my_org_auth_status(pg_temp.id('org_a'))), false,
  'the org session rules exempt an app, like an API key');

select pg_temp.as_platform();
select is((private.custom_access_token_hook(jsonb_build_object('user_id', pg_temp.id('mia_user'),
  'claims', jsonb_build_object('client_id', pg_temp.id('client')::text, 'sub', pg_temp.id('mia_user')::text))) -> 'claims' ->> 'org_id'),
  pg_temp.id('org_a')::text, 'the token hook names the app''s org in its token');

-- A client no registered app owns reaches nothing.
select pg_temp.as_session('mia', 'aal1', null, gen_random_uuid());
select set_config('role', 'postgres', true);
select is(private.api_key_scopes(), '{}'::text[], 'an unknown client''s session has no scopes');
select is((select count(*)::int from private.my_org_ids()), 0, 'and no org');

-- Revoking -------------------------------------------------------------------------------------------------------------

select pg_temp.as_platform();
insert into auth.oauth_consents (id, user_id, client_id, scopes) values (gen_random_uuid(), pg_temp.id('mia_user'), pg_temp.id('client'), 'email');
insert into auth.sessions (id, user_id, created_at, updated_at, aal, oauth_client_id)
values (gen_random_uuid(), pg_temp.id('mia_user'), now(), now(), 'aal1', pg_temp.id('client'));
select pg_temp.as_session('mia', 'aal1', null);
select is((select count(*)::int from app.my_oauth_apps()), 1, 'Connected apps lists mia''s grant');
update app.oauth_grants set deleted_at = now() where oauth_app_id = pg_temp.id('app') and person_id = pg_temp.id('mia') and deleted_at is null;
select pg_temp.as_platform();
select ok((select revoked_at is not null from auth.oauth_consents where user_id = pg_temp.id('mia_user') and client_id = pg_temp.id('client')),
  'revoking the grant revokes Supabase Auth''s consent');
select is((select count(*)::int from auth.sessions where user_id = pg_temp.id('mia_user') and oauth_client_id = pg_temp.id('client')), 0,
  'and ends the app''s sessions, so its refresh token stops working');
select pg_temp.as_session('mia', 'aal1', null, pg_temp.id('client'));
select set_config('role', 'postgres', true);
select is(private.api_key_scopes(), '{}'::text[], 'its access token reaches nothing any more');

-- A new consent replaces the old one without disconnecting the app.
select pg_temp.as_platform();
insert into auth.sessions (id, user_id, created_at, updated_at, aal, oauth_client_id)
values (gen_random_uuid(), pg_temp.id('dave_user'), now(), now(), 'aal1', pg_temp.id('client'));
select pg_temp.as_session('dave', 'aal1', null);
select lives_ok($$select app.grant_oauth_consent((select client_id from app_client), array['work'])$$,
  'dave consents again with fewer groups');
select pg_temp.as_platform();
select is((select count(*)::int from auth.sessions where user_id = pg_temp.id('dave_user') and oauth_client_id = pg_temp.id('client')), 1,
  'his app session survives the replacement');

-- Removing the app ends it everywhere.
select pg_temp.as_user('bob');
update app.oauth_apps set deleted_at = now() where id = pg_temp.id('app');
select pg_temp.as_platform();
select ok((select deleted_at is not null from auth.oauth_clients where id = pg_temp.id('client')), 'removing the app removes its client');
select is((select count(*)::int from app.oauth_grants where oauth_app_id = pg_temp.id('app') and deleted_at is null), 0, 'its grants end');
select is((select count(*)::int from auth.sessions where oauth_client_id = pg_temp.id('client')), 0, 'and every session of it');

select * from finish();
rollback;
