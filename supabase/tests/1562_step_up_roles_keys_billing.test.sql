-- pgTAP: migration 1562, step-up for role changes, API key creation and billing (A99, RRR-144; A65-002, trace row S9-08,
-- ADR 0055). Assigning or removing someone else's role, creating an API key and a signed-in caller's own write to the
-- subscription tables ask for a second factor passed in the last 15 minutes; an API key is refused outright. Joins the
-- platform makes (invitations, which the world fixture uses for every member) and writes by functions are not asked, and
-- every rule of the role guard still holds.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(19);

create function pg_temp.as_session(p_user text, p_aal text, p_second_ago interval, p_key boolean default false) returns void
language plpgsql as $$
declare
  v_amr jsonb := jsonb_build_array(jsonb_build_object('method', case when p_key then 'xos_api_key' else 'password' end,
    'timestamp', extract(epoch from now() - interval '1 hour')::bigint));
begin
  if p_second_ago is not null then
    v_amr := jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - p_second_ago)::bigint)) || v_amr;
  end if;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', pg_temp.id(p_user || '_user'), 'role', 'authenticated', 'aal', p_aal, 'amr', v_amr,
      'scopes', case when p_key then '["org"]'::jsonb end)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;


-- Role changes ---------------------------------------------------------------------------------------------------------------

select pg_temp.as_session('bob', 'aal1', null);
select throws_ok($$insert into app.membership_roles (membership_id, role_id)
  values ((select id from world where key = 'dave@org_a'), (select r.id from app.roles r where r.org_id is null and r.code = 'manager'))$$,
  'XR001', 'step_up_required: Confirm it is you with your second factor to change a member''s role.',
  'assigning someone a role needs step-up');
select pg_temp.as_session('bob', 'aal2', interval '20 minutes');
select throws_ok($$insert into app.membership_roles (membership_id, role_id)
  values ((select id from world where key = 'dave@org_a'), (select r.id from app.roles r where r.org_id is null and r.code = 'manager'))$$,
  'XR001', null, 'a second factor 20 minutes old is not recent enough');
select pg_temp.as_session('bob', 'aal2', interval '1 minute');
select lives_ok($$insert into app.membership_roles (membership_id, role_id)
  values ((select id from world where key = 'dave@org_a'), (select r.id from app.roles r where r.org_id is null and r.code = 'manager'))$$,
  'with a recent second factor the role is assigned');
select throws_ok($$insert into app.membership_roles (membership_id, role_id)
  values ((select id from world where key = 'bob@org_a'), (select r.id from app.roles r where r.org_id is null and r.code = 'manager'))$$,
  'XR001', 'sod_self_grant: A person cannot grant themselves a role or capability.', 'self-grants are still refused first');

select pg_temp.as_session('bob', 'aal1', null);
select throws_ok($$update app.membership_roles set deleted_at = now()
  where membership_id = (select id from world where key = 'dave@org_a') and deleted_at is null$$,
  'XR001', 'step_up_required: Confirm it is you with your second factor to change a member''s role.',
  'removing someone else''s role needs step-up');
select pg_temp.as_session('bob', 'aal1', null, true);
select throws_ok($$update app.membership_roles set deleted_at = now()
  where membership_id = (select id from world where key = 'dave@org_a') and deleted_at is null$$,
  'XR001', 'step_up_session_only: change a member''s role needs a signed-in session, never an API key.',
  'an API key never changes roles');
select pg_temp.as_session('bob', 'aal2', interval '1 minute');
select lives_ok($$update app.membership_roles set deleted_at = now()
  where membership_id = (select id from world where key = 'dave@org_a') and deleted_at is null
    and role_id = (select r.id from app.roles r where r.org_id is null and r.code = 'manager')$$,
  'with a recent second factor it is removed');

select pg_temp.as_platform();
select ok((select count(*) from app.membership_roles mr where mr.membership_id = pg_temp.id('dave@org_a') and mr.deleted_at is null) = 1,
  'the invitation dave accepted gave him his role without step-up, and he keeps it');

-- API keys -----------------------------------------------------------------------------------------------------------------

select pg_temp.as_session('alice', 'aal1', null);
select throws_ok($$select * from app.create_api_key((select id from world where key = 'org_a'), 'Payroll sync', array['crew'], now() + interval '30 days')$$,
  'XR001', 'step_up_required: Confirm it is you with your second factor to create an API key.', 'creating an API key needs step-up');
select pg_temp.as_session('alice', 'aal2', interval '1 minute');
select ok((select secret from app.create_api_key((select id from world where key = 'org_a'), 'Payroll sync', array['crew'], now() + interval '30 days')) ~ '^xos_live_',
  'with a recent second factor the key is created and shown once');
select pg_temp.as_session('alice', 'aal2', interval '1 minute', true);
select throws_ok($$select * from app.create_api_key((select id from world where key = 'org_a'), 'Nested', array['org'], null)$$,
  'XR001', null, 'an API key never creates another');
select pg_temp.as_session('carol', 'aal2', interval '1 minute');
select throws_ok($$select * from app.create_api_key((select id from world where key = 'org_a'), 'Mine', array['crew'], null)$$,
  '42501', null, 'without org.api_keys.manage the org reads as not found, as before');

-- Billing ------------------------------------------------------------------------------------------------------------------
-- Signed-in callers hold no write privilege on the subscription tables (the billing service writes them); the restrictive
-- policies keep step-up in force should a grant ever open them.

select ok(not has_table_privilege('authenticated', 'app.subscriptions', 'UPDATE')
  and not has_table_privilege('authenticated', 'app.subscriptions', 'INSERT')
  and not has_table_privilege('authenticated', 'app.subscription_state_transitions', 'INSERT'),
  'no signed-in caller writes the subscription tables directly');
select pg_temp.as_session('alice', 'aal1', null);
select set_config('role', 'postgres', true);
select throws_ok($$select private.billing_step_up((select id from world where key = 'org_a'))$$, 'XR001',
  'step_up_required: Confirm it is you with your second factor to change billing.',
  'the policy check asks the Owner for step-up');
select pg_temp.as_session('alice', 'aal2', interval '1 minute');
select set_config('role', 'postgres', true);
select is(private.billing_step_up(pg_temp.id('org_a')), true, 'and passes her with a recent second factor');
select pg_temp.as_session('dave', 'aal1', null);
select set_config('role', 'postgres', true);
select is(private.billing_step_up(pg_temp.id('org_a')), true,
  'someone without org.billing.manage is left to the permissive policies, which refuse them');
select pg_temp.as_platform();
select ok(exists (select 1 from pg_policies where schemaname = 'app' and tablename = 'subscriptions'
  and policyname = 'subscriptions_step_up_update' and permissive = 'RESTRICTIVE'), 'the step-up policies are restrictive');

-- Partner exit (A79's app.leave_partner) -----------------------------------------------------------------------------------

select pg_temp.as_session('cora', 'aal1', null);
select throws_ok($$select app.leave_partner((select id from world where key = 'org_c'), 'Tidewater Events')$$, 'XR001',
  'step_up_required: Confirm it is you with your second factor to leave your partner.',
  'leaving the partner, which ends the partner-billed subscription, needs step-up');
select pg_temp.as_session('cora', 'aal2', interval '1 minute');
select is(app.leave_partner(pg_temp.id('org_c'), 'Tidewater Events'), pg_temp.id('org_c'),
  'with a recent second factor the client org leaves');

select * from finish();
rollback;
