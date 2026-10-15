-- pgTAP: service accounts as database identities for API keys, and the token exchange lookup
-- (ADR 0003; orchestrator decision on API key token exchange, option a).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(31);

-- Creation ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into world select 'sa_ledger', app.create_service_account(pg_temp.id('org_a'), ' Ledger Export Bot ', pg_temp.system_role('member'));
select pg_temp.as_platform();
select results_eq($$select s.name, s.owner_person_id, s.org_id from app.service_accounts s where s.id = pg_temp.id('sa_ledger')$$,
  $$select 'Ledger Export Bot'::text, pg_temp.id('bob'), pg_temp.id('org_a')$$, 'an admin creates a service account and owns it');
select ok((select u.encrypted_password is null and u.email like 'service-account+%@service.xos.invalid'
  and u.raw_app_meta_data ->> 'provider' = 'xos_service_account'
  from auth.users u join app.service_accounts s on s.user_id = u.id where s.id = pg_temp.id('sa_ledger')),
  'its sign-in has no password and a reserved address');
select is((select p.full_name from app.people p join app.service_accounts s on s.person_id = p.id where s.id = pg_temp.id('sa_ledger')),
  'Ledger Export Bot', 'it has a person row named after it');
select ok(private.user_holds_active_membership((select user_id from app.service_accounts where id = pg_temp.id('sa_ledger')), pg_temp.id('org_a')),
  'it holds an active membership in the org');
select is((select r.code from app.membership_roles mr join app.roles r on r.id = mr.role_id
  join app.service_accounts s on s.membership_id = mr.membership_id where s.id = pg_temp.id('sa_ledger')), 'member',
  'the membership carries the chosen role');

select pg_temp.as_user('bob');
select throws_ok($$select app.create_service_account(pg_temp.id('org_a'), 'Root', pg_temp.system_role('owner'))$$,
  'XR001', 'service_account_owner_role: A service account cannot hold the Owner role.', 'Owner is refused');
select throws_ok($$select app.create_service_account(pg_temp.id('org_a'), 'Ghost', gen_random_uuid())$$,
  'XR001', 'service_account_role_unknown: Choose a role of this organization.', 'an unknown role is refused');
select throws_ok($$select app.create_service_account(pg_temp.id('org_a'), '', pg_temp.system_role('member'))$$,
  'XR001', null, 'a name is required');
select throws_ok($$select app.create_service_account(pg_temp.id('org_a'), 'Old', pg_temp.system_role('member'), now() - interval '1 day')$$,
  'XR001', 'service_account_expiry_invalid: Set the expiry after now, or leave it empty.', 'an expiry in the past is refused');

-- Role bands and tenants ---------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.create_service_account(pg_temp.id('org_a'), 'Manager Bot', pg_temp.system_role('member'))$$,
  '42501', 'organization not found', 'a manager cannot create service accounts');
select is((select count(*)::integer from app.service_accounts), 0, 'a manager reads no service accounts');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.service_accounts), 0, 'a member reads no service accounts');
select pg_temp.as_user('bob');
select is((select count(*)::integer from app.service_accounts), 1, 'an admin lists the org''s service accounts');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.service_accounts where org_id = pg_temp.id('org_a')), 0, 'no cross-tenant reads');
select throws_ok($$select app.create_service_account(pg_temp.id('org_a'), 'Cross', pg_temp.system_role('member'))$$,
  '42501', null, 'another org''s admin cannot create one here');
select throws_ok(format('select app.retire_service_account(%L)', pg_temp.id('sa_ledger')), '42501', 'service account not found',
  'another org''s admin cannot retire it');
select pg_temp.as_anon();
select throws_ok($$select app.create_service_account(gen_random_uuid(), 'Anon', gen_random_uuid())$$, '42501', null,
  'anon cannot create service accounts');

-- Updates -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok(format($$update app.service_accounts set name = 'Ledger Bot' where id = %L$$, pg_temp.id('sa_ledger')),
  'an admin renames a service account');
select throws_ok(format($$update app.service_accounts set user_id = gen_random_uuid() where id = %L$$, pg_temp.id('sa_ledger')),
  '42501', null, 'the sign-in is not writable');
select throws_ok(format($$update app.service_accounts set owner_person_id = %L where id = %L$$, pg_temp.id('xavier'), pg_temp.id('sa_ledger')),
  'XR001', 'service_account_owner_not_member: The owner must be an active member of the org.', 'the owner must be a member');

-- API keys acting for a service account --------------------------------------------------------------------------
create temporary table sa_key as
  select * from app.create_api_key(pg_temp.id('org_a'), 'Ledger Key', array['finance'], now() + interval '30 days', pg_temp.id('sa_ledger'));
grant select on sa_key to public;
create temporary table org_key as
  select * from app.create_api_key(pg_temp.id('org_a'), 'Org Key', array['org'], now() + interval '30 days');
grant select on org_key to public;
select is((select service_account_id from app.api_keys where id = (select api_key_id from sa_key)), pg_temp.id('sa_ledger'),
  'a key attaches to the service account');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.create_api_key(pg_temp.id('org_b'), 'Stolen', array['org'], now() + interval '1 day', %L)$$, pg_temp.id('sa_ledger')),
  'XR001', null, 'a key cannot act for another org''s service account');

-- Exchange ----------------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'app.exchange_api_key(text)', 'execute')
  and not has_function_privilege('authenticated', 'app.exchange_api_key(text)', 'execute'), 'only the token exchange resolves keys');
select pg_temp.as_platform();
set local role service_role;
select results_eq(format('select org_id, scopes, service_account_id from app.exchange_api_key(%L)', (select secret from sa_key)),
  format($$values (%L::uuid, array['finance']::text[], %L::uuid)$$, pg_temp.id('org_a'), pg_temp.id('sa_ledger')),
  'a key exchanges for its service account');
select is((select e.user_id from app.exchange_api_key((select secret from sa_key)) e),
  (select s.user_id from app.service_accounts s where s.id = pg_temp.id('sa_ledger')), 'the subject is the service account sign-in');
select throws_ok(format('select app.exchange_api_key(%L)', (select secret from org_key)), 'XR001',
  'api_key_needs_service_account: Attach this key to a service account before calling the API with it.',
  'a key without a service account is refused');
select is((select count(*)::integer from app.exchange_api_key('xos_live_' || repeat('1', 48))), 0, 'an unknown key exchanges for nothing');

-- Retirement ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok(format('select app.retire_service_account(%L)', pg_temp.id('sa_ledger')), 'an admin retires the service account');
select pg_temp.as_platform();
select ok((select revoked_at is not null from app.api_keys where id = (select api_key_id from sa_key)), 'its keys are revoked');
select ok(not private.user_holds_active_membership((select user_id from app.service_accounts where id = pg_temp.id('sa_ledger')), pg_temp.id('org_a')),
  'its membership ends');
set local role service_role;
select is((select count(*)::integer from app.exchange_api_key((select secret from sa_key))), 0, 'a retired account''s key exchanges for nothing');

select * from finish();
rollback;
