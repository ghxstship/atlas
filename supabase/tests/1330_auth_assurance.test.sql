-- pgTAP: migration 1330, authentication assurance (A77, RRR-122; A65-002, A65-001, A59-019, A69-007). Step-up for
-- break-glass and Restricted exports is an aal2 session, which a passkey sign-in alone is not. Changing one's own sign-in
-- methods asks for a second factor within 15 minutes. security.mfa_policy asks a second factor of admins or everyone by the
-- roles held now; security.session_hours ends a session for an org; security.idle_timeout_minutes reaches the guards; each
-- non-default value saves again (the 1299 guard is lifted). API-key sessions are exempt. Cross-member and anon denied.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(36);

-- A session signed in p_signed_in ago with its first factor, plus a second factor p_second_ago (NULL for none).
create function pg_temp.as_session(p_key text, p_aal text, p_first text, p_signed_in interval, p_second text, p_second_ago interval)
returns void
language plpgsql as $$
declare
  v_amr jsonb := jsonb_build_array(jsonb_build_object('method', p_first, 'timestamp', extract(epoch from now() - p_signed_in)::bigint));
begin
  if p_second is not null then
    v_amr := jsonb_build_array(jsonb_build_object('method', p_second, 'timestamp', extract(epoch from now() - p_second_ago)::bigint)) || v_amr;
  end if;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', p_aal,
      'session_id', gen_random_uuid(), 'amr', v_amr)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- Second-factor status ------------------------------------------------------------------------------------------------------

select pg_temp.as_session('alice', 'aal2', 'password', interval '2 hours', 'totp', interval '1 minute');
select is((select session_aal from app.my_second_factor_status()), 'aal2', 'a session that passed a code is aal2');
select is((select recent from app.my_second_factor_status()), true, 'a code a minute old is recent');
select ok((select recent_until - second_factor_at from app.my_second_factor_status()) = interval '15 minutes',
  'it stays recent for 15 minutes');

select pg_temp.as_session('alice', 'aal2', 'password', interval '2 hours', 'totp', interval '20 minutes');
select is((select session_aal from app.my_second_factor_status()), 'aal2', 'the session stays aal2 for its life');
select is((select recent from app.my_second_factor_status()), false, 'but a code 20 minutes old is not recent');

select pg_temp.as_session('alice', 'aal2', 'otp', interval '1 hour', 'mfa/webauthn', interval '30 seconds');
select is((select recent from app.my_second_factor_status()), true, 'a security key passed as a second factor counts');

select pg_temp.as_session('alice', 'aal1', 'passkey', interval '10 seconds', null, null);
select is((select session_aal from app.my_second_factor_status()), 'aal1', 'a passkey sign-in alone is aal1');
select is((select recent from app.my_second_factor_status()), false, 'and has no second factor to be recent');

select pg_temp.as_session('alice', 'aal1', 'password', interval '2 hours', 'totp', interval '1 minute');
select is((select recent from app.my_second_factor_status()), false, 'an amr entry without the aal2 claim is not recent');

-- Step-up callers ------------------------------------------------------------------------------------------------------------

select pg_temp.as_session('alice', 'aal1', 'passkey', interval '1 minute', null, null);
select throws_ok($$select app.start_break_glass((select id from world where key = 'org_a'), 'Payroll export failed during show day and must run now.')$$,
  'XR001', 'step_up_required: Verify with your second factor before taking emergency access.', 'a passkey sign-in alone cannot take emergency access');
select throws_ok($$select app.request_export((select id from world where key = 'org_a'), 'CSV', 'Pay rates', array['app.pay_rates.rate_minor'])$$,
  'XR001', 'step_up_required: Exporting Restricted columns needs step-up authentication.', 'nor export Restricted columns');
select pg_temp.as_session('alice', 'aal2', 'passkey', interval '2 hours', 'totp', interval '40 minutes');
select lives_ok($$select app.start_break_glass((select id from world where key = 'org_a'), 'Payroll export failed during show day and must run now.')$$,
  'a session that passed a code at sign-in takes emergency access');

-- MFA policy by role ---------------------------------------------------------------------------------------------------------

select pg_temp.as_platform();
select is(private.mfa_required(pg_temp.id('alice'), pg_temp.id('org_a')), false, 'the default policy asks no one');
select pg_temp.as_user('alice');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.mfa_policy', 'Organization', null, 'admins', null, null, false)$$,
  'admins saves now that it is enforced');
select pg_temp.as_platform();
select is(private.mfa_required(pg_temp.id('alice'), pg_temp.id('org_a')), true, 'admins: the Owner must use a second factor');
select is(private.mfa_required(pg_temp.id('bob'), pg_temp.id('org_a')), true, 'admins: an Admin must');
select is(private.mfa_required(pg_temp.id('carol'), pg_temp.id('org_a')), false, 'admins: a Manager need not');
select is(private.mfa_required(pg_temp.id('xavier'), pg_temp.id('org_a')), false, 'nobody outside the org is asked');
select is(private.mfa_required(pg_temp.id('xavier'), pg_temp.id('org_b')), false, 'another org keeps its own policy');

-- A role change applies at once.
insert into app.membership_roles (org_id, membership_id, role_id)
values (pg_temp.id('org_a'), pg_temp.id('carol@org_a'), pg_temp.system_role('admin'));
select is(private.mfa_required(pg_temp.id('carol'), pg_temp.id('org_a')), true, 'made an Admin, the Manager must now use a second factor');
update app.membership_roles set deleted_at = now()
where membership_id = pg_temp.id('carol@org_a') and role_id = pg_temp.system_role('admin');
select is(private.mfa_required(pg_temp.id('carol'), pg_temp.id('org_a')), false, 'and need not once the role is gone');

select pg_temp.as_user('alice');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.mfa_policy', 'Organization', null, 'everyone', null, null, false)$$,
  'everyone saves');
select pg_temp.as_platform();
select is(private.mfa_required(pg_temp.id('frank'), pg_temp.id('org_a')), true, 'everyone: a Field member must too');

-- What the org asks of the session --------------------------------------------------------------------------------------------

select pg_temp.as_session('dave', 'aal1', 'password', interval '1 hour', null, null);
select is((select mfa_required from app.my_org_auth_status(pg_temp.id('org_a'))), true, 'the status says a second factor is required');
select is((select mfa_verified from app.my_org_auth_status(pg_temp.id('org_a'))), false, 'and that this session has not passed one');
select pg_temp.as_session('dave', 'aal2', 'password', interval '1 hour', 'totp', interval '50 minutes');
select is((select mfa_verified from app.my_org_auth_status(pg_temp.id('org_a'))), true, 'a session that passed one at sign-in meets the policy');
select is((select session_hours from app.my_org_auth_status(pg_temp.id('org_a'))), 336, 'the default session lifetime is 14 days');

select pg_temp.as_user('alice');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.session_hours', 'Organization', null, null, null, 8, false)$$,
  'an 8-hour session lifetime saves');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.idle_timeout_minutes', 'Organization', null, null, null, 15, false)$$,
  'a 15-minute idle timeout saves');
select pg_temp.as_session('dave', 'aal2', 'password', interval '9 hours', 'totp', interval '9 hours');
select is((select session_expired from app.my_org_auth_status(pg_temp.id('org_a'))), true, 'a sign-in older than the org''s 8 hours has ended for the org');
select pg_temp.as_session('dave', 'aal2', 'password', interval '1 hour', 'totp', interval '1 hour');
select is((select session_expired from app.my_org_auth_status(pg_temp.id('org_a'))), false, 'a sign-in an hour old has not');
select ok((select session_expires_at - signed_in_at from app.my_org_auth_status(pg_temp.id('org_a'))) = interval '8 hours', 'it ends 8 hours after sign-in');
select is((select idle_timeout_minutes from app.my_org_auth_status(pg_temp.id('org_a'))), 15, 'the guards read the 15-minute idle timeout');

select pg_temp.as_session('xavier', 'aal1', 'password', interval '1 hour', null, null);
select is((select count(*)::int from app.my_org_auth_status(pg_temp.id('org_a'))), 0, 'a non-member learns nothing about another org');

select set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('dave_user'), 'role', 'authenticated',
  'scopes', json_build_array('data'), 'amr', json_build_array(json_build_object('method', 'xos_api_key', 'timestamp', 0)))::text, true);
select is((select mfa_required or session_expired from app.my_org_auth_status(pg_temp.id('org_a'))), false, 'an API-key session is exempt');

select pg_temp.as_anon();
select throws_ok($$select * from app.my_org_auth_status(gen_random_uuid())$$, '42501', null, 'anon cannot ask');

select * from finish();
rollback;
