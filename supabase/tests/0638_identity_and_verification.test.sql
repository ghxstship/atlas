-- pgTAP: identity and verification integrations. OAuth apps and consent grants; identity providers with plan gates,
-- the Owner-role ban and hashed SCIM tokens; SSO just-in-time joins; SCIM provisioning with group mappings and
-- deprovisioning; organization verification requests checked by the verifier. RLS, role bands and refusals throughout.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

create function pg_temp.as_stepped_up(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- OAuth apps -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
with a as (insert into app.oauth_apps (org_id, name, redirect_uri, client_id) values (pg_temp.id('org_a'), 'Show Planner', 'https://planner.example.com/callback', 'xos_client_chosen') returning id, client_id)
  insert into world select 'app', id from a;
select ok((select client_id ~ '^xos_client_[0-9a-f]{24}$' from app.oauth_apps where id = pg_temp.id('app')), 'the database issues the client id');
select throws_ok($$update app.oauth_apps set client_id = 'xos_client_000000000000000000000000' where id = (select id from world where key = 'app')$$,
  'XR001', 'oauth_client_id_fixed: A client id never changes; register a new app instead.', 'a client id never changes');
select throws_ok($$insert into app.oauth_apps (org_id, name, redirect_uri) values ((select id from world where key = 'org_a'), 'Bad', 'http://planner.example.com/callback')$$,
  '23514', null, 'redirect URIs use HTTPS');
select lives_ok($$insert into app.oauth_apps (org_id, name, redirect_uri) values ((select id from world where key = 'org_a'), 'Native', 'http://127.0.0.1:8123/callback')$$, 'or a loopback address for native apps');
select throws_ok($$insert into app.oauth_apps (org_id, name, redirect_uri) values ((select id from world where key = 'org_a'), 'Bad', 'https://planner.example.com/cb#frag')$$,
  '23514', null, 'and never a fragment');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.oauth_apps (org_id, name, redirect_uri) values ((select id from world where key = 'org_a'), 'Mine', 'https://x.example.com')$$, '42501', null, 'a Manager cannot register apps');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.oauth_apps), 0, 'another org reads no apps');
select pg_temp.as_anon();
select throws_ok('select 1 from app.oauth_apps', '42501', null, 'anon cannot read apps');

-- OAuth grants
select pg_temp.as_platform();
create temporary table k (key text primary key, val text);
grant select, insert on k to public;
insert into k select 'client', client_id from app.oauth_apps where name = 'Show Planner';
select pg_temp.as_user('dave');
select throws_ok($$select app.grant_oauth_consent('xos_client_unknown', array['records'])$$, 'XR001', 'oauth_client_unknown: This app is not registered.', 'an unknown client is refused');
select throws_ok($$select app.grant_oauth_consent((select val from k where key = 'client'), array['nonsense'])$$,
  'XR001', 'oauth_scope_unknown: nonsense is not a capability group.', 'scopes are capability groups');
insert into world select 'grant', app.grant_oauth_consent((select val from k where key = 'client'), array['work', 'projects', 'work']);
select is((select scopes from app.oauth_grants where id = pg_temp.id('grant')), array['projects', 'work'], 'a member consents with distinct, sorted scopes');
select is((select person_id from app.oauth_grants where id = pg_temp.id('grant')), pg_temp.id('dave'), 'as themselves');
insert into world select 'grant2', app.grant_oauth_consent((select val from k where key = 'client'), array['work']);
select is((select count(*)::int from app.oauth_grants where deleted_at is null), 1, 'a new consent replaces the old one');
select throws_ok($$update app.oauth_grants set scopes = array['finance'] where id = (select id from world where key = 'grant2')$$,
  'XR001', 'oauth_grant_fixed: A consent is never edited; consent again to change it.', 'a consent is never edited');
select lives_ok($$update app.oauth_grants set deleted_at = now() where id = (select id from world where key = 'grant2')$$, 'the person revokes their consent');
select pg_temp.as_user('xavier');
select throws_ok($$select app.grant_oauth_consent((select val from k where key = 'client'), array['work'])$$, 'XR001', 'oauth_not_member: Only members of the org that registered the app can consent to it.', 'only members of the app''s org consent');
select pg_temp.as_platform();
select throws_ok($$select app.grant_oauth_consent((select val from k where key = 'client'), array['work'])$$, '42501', null, 'consent needs a signed-in person');
select pg_temp.as_user('mia');
select lives_ok($$select app.grant_oauth_consent((select val from k where key = 'client'), array['work'])$$, 'another member consents');
select is((select count(*)::int from app.oauth_grants), 1, 'and reads only their own grants');
select pg_temp.as_user('bob');
select is((select count(*)::int from app.oauth_grants), 3, 'an integrations Admin reads every grant to the org''s apps');
update app.oauth_grants set deleted_at = now() where person_id = pg_temp.id('mia');
select is((select count(*)::int from app.oauth_grants where person_id = pg_temp.id('mia') and deleted_at is null), 1, 'but cannot revoke someone else''s');

-- Identity providers ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$insert into app.identity_providers (org_id, protocol, name, auth_provider_id, default_role_id) values ((select id from world where key = 'org_a'), 'SAML', 'Okta', 'prov-1', pg_temp.system_role('member'))$$,
  'XR001', 'integration_plan_feature: Enterprise single sign-on needs a plan with the saml_sso feature.', 'SSO needs the saml_sso plan feature');
select pg_temp.as_platform();
update app.subscriptions set plan_code = 'enterprise' where org_id = pg_temp.id('org_a');
select pg_temp.as_user('bob');
select throws_ok($$insert into app.identity_providers (org_id, protocol, name, auth_provider_id, default_role_id) values ((select id from world where key = 'org_a'), 'SAML', 'Okta', 'prov-1', pg_temp.system_role('owner'))$$,
  'XR001', 'sso_default_role_owner: Single sign-on never makes anyone an Owner; choose another default role.', 'SSO never makes anyone an Owner');
select throws_ok($$insert into app.identity_providers (org_id, protocol, name, auth_provider_id, default_role_id, scim_token_hash, scim_token_prefix) values ((select id from world where key = 'org_a'), 'SAML', 'Okta', 'prov-1', pg_temp.system_role('member'), extensions.digest('x', 'sha256'), 'xos_scim_x')$$,
  'XR001', 'scim_token_rpc_only: Issue SCIM tokens through app.issue_scim_token.', 'SCIM tokens are issued only by the RPC');
with p as (insert into app.identity_providers (org_id, protocol, name, auth_provider_id, default_role_id, jit_enabled, scim_enabled)
  values (pg_temp.id('org_a'), 'SAML', 'Northwind Okta', 'prov-1', pg_temp.system_role('member'), true, true) returning id) insert into world select 'idp', id from p;
select throws_ok($$select scim_token_hash from app.identity_providers$$, '42501', null, 'the token hash is never readable');
select is((select count(*)::int from app.identity_providers), 1, 'an Admin reads the provider');
select pg_temp.as_user('carol');
update app.identity_providers set jit_enabled = false;
select pg_temp.as_platform();
select ok((select jit_enabled from app.identity_providers where id = pg_temp.id('idp')), 'a Manager cannot change SSO');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.identity_providers), 0, 'another org reads none');

-- SCIM tokens
select pg_temp.as_user('bob');
select throws_ok($$select app.issue_scim_token((select id from world where key = 'idp'))$$, 'XR001', 'step_up_required: Issuing a SCIM token needs step-up authentication.', 'a SCIM token needs step-up');
select pg_temp.as_stepped_up('bob');
insert into k values ('token', app.issue_scim_token(pg_temp.id('idp')));
select ok((select val like 'xos_scim_%' from k where key = 'token'), 'the token is shown once');
select is((select scim_token_prefix from app.identity_providers where id = pg_temp.id('idp')), (select left(val, 13) from k where key = 'token'), 'only its prefix stays visible');
select pg_temp.as_stepped_up('carol');
select throws_ok($$select app.issue_scim_token((select id from world where key = 'idp'))$$, '42501', null, 'a Manager cannot issue tokens');
select pg_temp.as_platform();
select is(app.scim_provider_for_token((select val from k where key = 'token')), pg_temp.id('idp'), 'the endpoint finds the provider by token');
select is(app.scim_provider_for_token('xos_scim_wrong'), null, 'a wrong token finds nothing');

-- SCIM provisioning
select pg_temp.as_user('alice');
with g as (insert into app.scim_group_mappings (identity_provider_id, idp_group, role_id, team_id) values (pg_temp.id('idp'), 'event-finance', pg_temp.system_role('manager'), pg_temp.id('team_a')) returning id) insert into world select 'map', id from g;
select throws_ok($$insert into app.scim_group_mappings (identity_provider_id, idp_group, role_id) values ((select id from world where key = 'idp'), 'owners', pg_temp.system_role('owner'))$$,
  'XR001', 'sso_default_role_owner: Single sign-on never makes anyone an Owner; map the group to another role.', 'groups never map to Owner');
select throws_ok($$insert into app.scim_group_mappings (identity_provider_id, idp_group) values ((select id from world where key = 'idp'), 'nothing')$$, '23514', null, 'a mapping names a role or a team');
select pg_temp.as_platform();
select throws_ok($$select app.scim_provision((select id from world where key = 'idp'), 'okta-1', 'x@northwind.test', gen_random_uuid(), true, array['event-finance'])$$,
  'XR001', 'scim_user_unknown: Create the auth user before provisioning it.', 'the auth user must exist');
insert into world select 'nina_membership', app.scim_provision(pg_temp.id('idp'), 'okta-nina', 'nina@nowhere.test', pg_temp.id('nina_user'), true, array['event-finance', ' event-finance ']);
select is((select person_id from app.memberships where id = pg_temp.id('nina_membership')), pg_temp.id('nina'), 'an active SCIM user joins the org');
select is((select count(*)::int from app.membership_roles where membership_id = pg_temp.id('nina_membership') and deleted_at is null), 2, 'with the default role and the mapped group role');
select is((select count(*)::int from app.team_members where membership_id = pg_temp.id('nina_membership') and deleted_at is null), 1, 'and joins the mapped team');
select is((select groups from app.scim_identities where external_id = 'okta-nina'), array['event-finance'], 'the groups are kept, trimmed and distinct');
select is(app.scim_provision(pg_temp.id('idp'), 'okta-nina', 'nina@nowhere.test', pg_temp.id('nina_user'), true, array[]::text[]), pg_temp.id('nina_membership'), 'leaving every group keeps the membership');
select is((select count(*)::int from app.membership_roles where membership_id = pg_temp.id('nina_membership') and deleted_at is null), 1, 'but takes back the group role');
select is((select count(*)::int from app.team_members where membership_id = pg_temp.id('nina_membership') and deleted_at is null), 0, 'and the team');
select throws_ok($$select app.scim_provision((select id from world where key = 'idp'), 'okta-nina', 'nina@nowhere.test', (select id from world where key = 'mia_user'), true, '{}')$$,
  'XR001', 'scim_identity_person_fixed: A SCIM user stays linked to the person it was provisioned as.', 'a SCIM user stays linked to its person');
select is(app.scim_provision(pg_temp.id('idp'), 'okta-nina', 'nina@nowhere.test', pg_temp.id('nina_user'), false, '{}'), null::uuid, 'deactivating returns no membership');
select ok((select valid_to is not null from app.memberships where id = pg_temp.id('nina_membership')), 'deactivation ends the membership');
select is((select count(*)::int from app.offboardings where membership_id = pg_temp.id('nina_membership')), 1, 'which opens offboarding');
select pg_temp.as_user('bob');
select throws_ok($$select app.scim_provision((select id from world where key = 'idp'), 'x', 'nina@nowhere.test', (select id from world where key = 'nina_user'), true, '{}')$$, '42501', null, 'signed-in callers cannot provision');
select is((select count(*)::int from app.scim_identities), 1, 'an Admin reads SCIM identities');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.scim_identities), 0, 'a Manager reads none');

-- SSO just-in-time join
select pg_temp.new_user('sara', 'sara@northwind.test', 'Sara Lindgren');
select pg_temp.as_user('sara');
select throws_ok($$select app.join_by_sso((select id from world where key = 'org_a'))$$, 'XR001', 'sso_session_required: Sign in through your organization''s single sign-on first.', 'a password session cannot join by SSO');
select pg_temp.as_platform();
update auth.users set raw_app_meta_data = '{"provider": "sso:prov-1"}' where id = pg_temp.id('sara_user');
select pg_temp.as_user('sara');
select lives_ok($$insert into world select 'sara_membership', app.join_by_sso((select id from world where key = 'org_a'))$$, 'a person signed in through the provider joins just in time');
select is((select r.code from app.membership_roles mr join app.roles r on r.id = mr.role_id where mr.membership_id = pg_temp.id('sara_membership')), 'member', 'with the default role');
select throws_ok($$select app.join_by_sso((select id from world where key = 'org_b'))$$, 'XR001', 'sso_join_unavailable: This organization does not add people who sign in through this identity provider.', 'the provider joins only its own org');
select pg_temp.as_user('bob');
update app.identity_providers set jit_enabled = false where id = pg_temp.id('idp');
select pg_temp.new_user('tom', 'tom@northwind.test', 'Tom Ibarra');
select pg_temp.as_platform();
update auth.users set raw_app_meta_data = '{"provider": "sso:prov-1"}' where id = pg_temp.id('tom_user');
select pg_temp.as_user('tom');
select throws_ok($$select app.join_by_sso((select id from world where key = 'org_a'))$$, 'XR001', 'sso_join_unavailable: This organization does not add people who sign in through this identity provider.', 'no join when just-in-time joins are off');

-- Organization verification requests --------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
with r as (insert into app.organization_verification_requests (org_id, method, provider_reference) values (pg_temp.id('org_a'), 'Business Registry', 'us_fl/P12000012345') returning id) insert into world select 'req', id from r;
with r as (insert into app.organization_verification_requests (org_id, method, provider_reference) values (pg_temp.id('org_a'), 'Stripe Identity', 'vs_fixture_1') returning id) insert into world select 'req_stripe', id from r;
select throws_ok($$insert into app.organization_verification_requests (org_id, method, provider_reference) values ((select id from world where key = 'org_a'), 'Business Registry', 'Florida 123')$$,
  'XR001', 'verification_reference_invalid: Name the registry entry as <jurisdiction>/<company number>, for example us_fl/P12000012345.', 'registry references name jurisdiction and number');
select throws_ok($$insert into app.organization_verification_requests (org_id, method, provider_reference, request_state, failure_reason) values ((select id from world where key = 'org_a'), 'Stripe Identity', 'vs_2', 'Failed', 'x')$$,
  'XR001', 'verification_request_verifier_only: Only the verifier records the outcome of a verification request.', 'a request starts Pending');
select throws_ok($$update app.organization_verification_requests set request_state = 'Failed', failure_reason = 'x' where id = (select id from world where key = 'req')$$,
  'XR001', 'verification_request_verifier_only: Only the verifier records the outcome of a verification request.', 'only the verifier records outcomes');
select throws_ok($$select app.record_organization_check((select id from world where key = 'req'), true, null)$$, '42501', null, 'signed-in callers cannot record checks');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.organization_verification_requests (org_id, method, provider_reference) values ((select id from world where key = 'org_a'), 'Stripe Identity', 'vs_3')$$, '42501', null, 'a Manager cannot request verification');
select pg_temp.as_platform();
select is(app.record_organization_check(pg_temp.id('req_stripe'), null, null), 'Pending'::app.verification_request_state, 'a check still pending at the provider only stamps the time');
select is(app.record_organization_check(pg_temp.id('req'), true, null, now() + interval '1 year'), 'Passed'::app.verification_request_state, 'a passed check');
select ok(app.organization_verified(pg_temp.id('org_a')), 'records the verification through A30 and the verified flag shows');
select is(app.record_organization_check(pg_temp.id('req_stripe'), false, 'The document did not match the business name.'), 'Failed'::app.verification_request_state, 'a failed check keeps its reason');
select throws_ok($$select app.record_organization_check((select id from world where key = 'req'), false, 'Late.')$$,
  'XR001', 'verification_request_decided: The verification request already has an outcome.', 'an outcome is final');
select throws_ok($$select app.record_organization_check(gen_random_uuid(), true, null)$$,
  'XR001', 'verification_request_unknown: The verification request does not exist or was withdrawn.', 'an unknown request is refused');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.organization_verification_requests), 0, 'another org reads no requests');

select * from finish();
rollback;
