-- pgTAP: migration 1332 (A77, RRR-122). After a single sign-on the session's own identity provider decides the org: a
-- provider that adds people just in time joins the person with its default role, once; a provider that does not, an
-- unknown provider or a session that is not a single sign-on joins nothing. The SCIM endpoint finds an existing sign-in
-- by email, case-insensitively, with the service role only.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(10);

select pg_temp.as_platform();
update app.subscriptions set plan_code = 'enterprise' where org_id = pg_temp.id('org_a');
insert into app.identity_providers (org_id, protocol, name, auth_provider_id, default_role_id, jit_enabled)
values (pg_temp.id('org_a'), 'SAML', 'Northwind Okta', 'prov-jit', pg_temp.system_role('member'), true);
insert into app.identity_providers (org_id, protocol, name, auth_provider_id, default_role_id, jit_enabled)
values (pg_temp.id('org_a'), 'SAML', 'Northwind Azure', 'prov-closed', pg_temp.system_role('member'), false);
select pg_temp.new_user('sam', 'Sam@Northwind.test', 'Sam Okta');
select pg_temp.new_user('una', 'una@northwind.test', 'Una Azure');
update auth.users set raw_app_meta_data = jsonb_build_object('provider', 'sso:prov-jit') where id = pg_temp.id('sam_user');
update auth.users set raw_app_meta_data = jsonb_build_object('provider', 'sso:prov-closed') where id = pg_temp.id('una_user');

select pg_temp.as_user('sam');
select is((select slug from app.join_by_sso_session()), 'northwind-live', 'a just-in-time provider joins its org');
select pg_temp.as_platform();
select is((select r.code from app.memberships m join app.membership_roles mr on mr.membership_id = m.id join app.roles r on r.id = mr.role_id
  where m.person_id = pg_temp.id('sam') and m.org_id = pg_temp.id('org_a') and mr.deleted_at is null), 'member',
  'with the provider''s default role');
select pg_temp.as_user('sam');
select is((select joined from app.join_by_sso_session()), false, 'signing in again finds the membership and joins nothing new');
select pg_temp.as_platform();
select is((select count(*)::int from app.memberships where person_id = pg_temp.id('sam') and org_id = pg_temp.id('org_a') and deleted_at is null), 1,
  'one membership, however often the person signs in');

select pg_temp.as_user('una');
select is((select count(*)::int from app.join_by_sso_session()), 0, 'a provider that does not add people joins nothing');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.join_by_sso_session()), 0, 'a password session joins nothing');

select pg_temp.as_platform();
update auth.users set raw_app_meta_data = jsonb_build_object('provider', 'sso:prov-unknown') where id = pg_temp.id('una_user');
select pg_temp.as_user('una');
select is((select count(*)::int from app.join_by_sso_session()), 0, 'an unknown provider joins nothing');

-- The SCIM endpoint's user lookup.
select pg_temp.as_platform();
set local role service_role;
select is(app.scim_user_for_email(' sam@northwind.TEST '), pg_temp.id('sam_user'), 'the endpoint finds a sign-in by email, ignoring case');
select is(app.scim_user_for_email('nobody@northwind.test'), null, 'and nothing for an unknown address');
reset role;
select pg_temp.as_user('dave');
select throws_ok($$select app.scim_user_for_email('sam@northwind.test')$$, '42501', null, 'a signed-in person cannot look up sign-ins');

select * from finish();
rollback;
