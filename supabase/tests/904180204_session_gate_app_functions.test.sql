-- pgTAP: migration 904180204, the functions the apps read (ADR 0169 work package 2, RRR-243). With every control off
-- app.my_org_auth_status and app.network_access answer as before and their new columns read as passing; in enforce
-- they give the verdict's answer, also to a session an organization refuses. app.my_session_gate names each of the
-- caller's organizations and why it is closed. app.touch_my_session records an activity and writes the network pass
-- from a verified attestation only, never from the address the client sends, and a touch after the idle timeout does
-- not revive the session. private.require_second_factor refuses a signed-out session where the signed-out control
-- is enforced, and nowhere else. Turning security.mfa_policy on needs an aal2 session where the second-factor
-- control is in observe or enforce.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql
\ir 904180200_session_gate_fixture.psql

select plan(53);

select pg_temp.rule('org_a', 'alice', 'security.mfa_policy', 'everyone');
select pg_temp.rule('org_a', 'alice', 'security.session_hours', p_integer => 8);
select pg_temp.rule('org_a', 'alice', 'security.idle_timeout_minutes', p_integer => 15);
select pg_temp.allow_network('org_a', 'alice', '203.0.113.0/24');

-- Off: as before, and the new columns pass -------------------------------------------------------------------------------------

select pg_temp.as_session('dave', 'aal1', interval '9 hours', interval '20 minutes');
select results_eq($$select mfa_required, mfa_verified, session_hours, session_expired, idle_timeout_minutes, session_ended
                    from app.my_org_auth_status(pg_temp.id('org_a'))$$,
  $$values (true, false, 8, true, 15, false)$$, 'off: app.my_org_auth_status reports what the organization asks, as before');
select results_eq($$select idle, network_allowed, blocked_reason from app.my_org_auth_status(pg_temp.id('org_a'))$$,
  $$values (false, true, null::text)$$, 'off: its three new columns read as passing');
select results_eq($$select enforced, allowed, covered, network_allowed, blocked_reason from app.network_access(pg_temp.id('org_a'), '198.51.100.7')$$,
  $$values (true, false, false, true, null::text)$$, 'off: app.network_access judges the given address as before, and its new columns pass');
select results_eq($$select enforced, allowed, covered from app.network_access(pg_temp.id('org_a'), '203.0.113.40')$$,
  $$values (true, true, true)$$, 'off: an address inside the list is allowed and covered, as before');
select results_eq($$select org_name, closed, reason from app.my_session_gate()$$,
  $$values ('Northwind Live', false, null::text)$$, 'off: app.my_session_gate names the organization and nothing is closed');
select is((select count(*)::int from app.my_org_auth_status(pg_temp.id('org_b'))), 0, 'a non-member still learns nothing about another org');
select is((select count(*)::int from app.network_access(pg_temp.id('org_b'), '203.0.113.40')), 0, 'nor about its network');

-- Enforce: one answer for Atlas, the XOS API and Compass -----------------------------------------------------------------------

select pg_temp.gate_all('enforce');
select results_eq($$select idle, network_allowed, blocked_reason from app.my_org_auth_status(pg_temp.id('org_a'))$$,
  $$values (true, false, 'session_expired')$$,
  'enforce: an expired, idle, single-factor session outside the network reads idle, not network_allowed, and the strongest reason');
select results_eq($$select mfa_required, mfa_verified, session_expired, session_ended from app.my_org_auth_status(pg_temp.id('org_a'))$$,
  $$values (true, false, true, false)$$, 'enforce: the columns the apps already read are unchanged');
select results_eq($$select enforced, allowed, network_allowed, blocked_reason from app.network_access(pg_temp.id('org_a'), '203.0.113.40')$$,
  $$values (true, true, false, 'session_expired')$$,
  'enforce: app.network_access still answers a refused session, and network_allowed is the database''s own judgment, not the given address');
select results_eq($$select org_name, closed, reason from app.my_session_gate()$$,
  $$values ('Northwind Live', true, 'session_expired')$$, 'enforce: a refused session reads which organization refuses it and why');

select pg_temp.as_session('mia', 'aal2', interval '10 minutes');
select results_eq($$select org_name, closed, reason from app.my_session_gate()$$,
  $$values ('Harbor Lights Productions', false, null::text), ('Northwind Live', true, 'network_restricted')$$,
  'enforce: a member of two organizations reads each by name, one open and one closed');
select results_eq($$select idle, network_allowed, blocked_reason from app.my_org_auth_status(pg_temp.id('org_b'))$$,
  $$values (false, true, null::text)$$, 'enforce: the organization that admits the session reads as passing');

select pg_temp.as_session('mia', 'aal2', interval '10 minutes', p_row => false);
select results_eq($$select org_name, closed, reason from app.my_session_gate()$$,
  $$values ('Harbor Lights Productions', true, 'session_ended'), ('Northwind Live', true, 'session_ended')$$,
  'enforce: a signed-out session reads session_ended for every organization');
select results_eq($$select session_ended, blocked_reason from app.my_org_auth_status(pg_temp.id('org_b'))$$,
  $$values (true, 'session_ended')$$, 'enforce: and app.my_org_auth_status agrees');

select pg_temp.token(jsonb_build_object('sub', pg_temp.id('dave_user'), 'role', 'authenticated', 'scopes', jsonb_build_array('data'),
  'amr', jsonb_build_array(jsonb_build_object('method', 'xos_api_key', 'timestamp', 0))));
select results_eq($$select mfa_required, session_expired, session_ended, idle, network_allowed, blocked_reason from app.my_org_auth_status(pg_temp.id('org_a'))$$,
  $$values (false, false, false, false, false, 'network_restricted')$$,
  'enforce: an API key is exempt from the session rules and bound by the allow-list');

select pg_temp.as_anon();
select throws_ok($$select * from app.my_session_gate()$$, '42501', null, 'anon cannot ask the gate');
select throws_ok($$select * from app.my_org_auth_status(gen_random_uuid())$$, '42501', null, 'nor the status');
select throws_ok($$select * from app.network_access(gen_random_uuid(), '203.0.113.40')$$, '42501', null, 'nor the network');
select pg_temp.as_platform();
select ok(has_function_privilege('authenticated', 'app.my_session_gate()', 'execute')
  and has_function_privilege('authenticated', 'app.my_org_auth_status(uuid)', 'execute')
  and has_function_privilege('authenticated', 'app.network_access(uuid, text)', 'execute')
  and has_function_privilege('service_role', 'app.network_access(uuid, text)', 'execute')
  and has_function_privilege('authenticated', 'app.touch_my_session(text, text, text, text, text)', 'execute'),
  'the four functions keep their grants');
select is(to_regprocedure('app.touch_my_session(text, text, text, text)'), null, 'the four-argument touch is replaced, not kept beside the new one');

-- The touch: activity, and a pass from an attestation only ------------------------------------------------------------------

select pg_temp.gate_all('off');
insert into world values ('touch', pg_temp.as_session('dave', 'aal2', interval '10 minutes'));
select lives_ok($$select app.touch_my_session('Atlas', '203.0.113.40', 'Lisbon, Portugal', 'pgTAP browser')$$,
  'a call with the four arguments released clients send still resolves');
select pg_temp.as_platform();
select is((select surface || ' ' || host(client_address) from private.session_devices where session_id = pg_temp.id('touch')), 'Atlas 203.0.113.40',
  'the device is recorded as before');
select results_eq($$select last_activity_at = now(), pass_address, pass_at from private.session_state where session_id = pg_temp.id('touch')$$,
  $$values (true, null::inet, null::timestamptz)$$,
  'the touch is an activity of the session, and the address the client sent is never its network pass');

select pg_temp.session_state(pg_temp.id('touch'), interval '30 seconds', interval '2 minutes');
select pg_temp.present_token(pg_temp.access_token(pg_temp.id('dave_user'), pg_temp.id('touch'), 'aal2',
  pg_temp.amr('password', interval '10 minutes', 'totp', interval '1 minute')));
select app.touch_my_session('Atlas', '203.0.113.40', 'Lisbon, Portugal', 'pgTAP browser');
select pg_temp.as_platform();
select is((select now() - last_activity_at from private.session_state where session_id = pg_temp.id('touch')), interval '30 seconds',
  'a second touch inside a minute writes nothing');

select pg_temp.present_token(pg_temp.access_token(pg_temp.id('dave_user'), pg_temp.id('touch'), 'aal2',
  pg_temp.amr('password', interval '10 minutes', 'totp', interval '1 minute')));
select app.touch_my_session('Compass', null, null, null, pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('touch'), '203.0.113.77'));
select pg_temp.as_platform();
select results_eq($$select pass_address, pass_at = now(), last_activity_at = now() from private.session_state where session_id = pg_temp.id('touch')$$,
  $$values ('203.0.113.77'::inet, true, true)$$, 'a touch with a signed attestation renews the pass at the attested address, at once');

select pg_temp.present_token(pg_temp.access_token(pg_temp.id('dave_user'), pg_temp.id('touch'), 'aal2',
  pg_temp.amr('password', interval '10 minutes', 'totp', interval '1 minute')));
select app.touch_my_session('Compass', '198.51.100.7', null, null,
  pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('touch'), '198.51.100.7', p_key => repeat('f', 64)));
select pg_temp.as_platform();
select is((select host(pass_address) from private.session_state where session_id = pg_temp.id('touch')), '203.0.113.77',
  'a touch with a forged attestation leaves the pass as it was');

select pg_temp.present_token(pg_temp.access_token(pg_temp.id('dave_user'), pg_temp.id('touch'), 'aal2',
  pg_temp.amr('password', interval '10 minutes', 'totp', interval '1 minute')));
select pg_temp.request_headers(jsonb_build_object('x-xos-attestation',
  pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('touch'), '203.0.113.88')));
select app.touch_my_session('Atlas', null, null, null);
select pg_temp.request_headers(null);
select pg_temp.as_platform();
select is((select host(pass_address) from private.session_state where session_id = pg_temp.id('touch')), '203.0.113.88',
  'the attestation our servers send as the request header renews the pass too');

-- The gap is folded in, so a touch after the timeout does not revive the session.
select pg_temp.gate('idle', 'enforce');
insert into world values ('late', pg_temp.as_session('dave', 'aal2', interval '40 minutes', interval '20 minutes'));
select is(pg_temp.org_reasons('org_a'), 'session_idle', 'idle enforce: the session is idle before the touch');
select app.touch_my_session('Compass', null, null, null);
select is(pg_temp.org_reasons('org_a'), 'session_idle', 'idle enforce: a touch sent after the timeout does not revive it');
select pg_temp.as_platform();
select ok((select longest_gap >= interval '20 minutes' from private.session_state where session_id = pg_temp.id('late')),
  'the touch recorded the gap it ended');
select pg_temp.gate('idle', 'off');

-- Who the touch ignores.
select pg_temp.token(jsonb_build_object('sub', pg_temp.id('dave_user'), 'role', 'authenticated', 'scopes', jsonb_build_array('data'),
  'session_id', pg_temp.id('touch'), 'amr', jsonb_build_array(jsonb_build_object('method', 'xos_api_key', 'timestamp', 0))));
select pg_temp.session_state(pg_temp.id('touch'), interval '10 minutes');
select app.touch_my_session('API', null, null, null);
select pg_temp.as_platform();
select is((select now() - last_activity_at from private.session_state where session_id = pg_temp.id('touch')), interval '10 minutes',
  'an API key records no activity');
select pg_temp.as_session('dave', 'aal2', interval '10 minutes', p_row => false);
select app.touch_my_session('Atlas', null, null, null);
select pg_temp.as_platform();
select is((select count(*)::int from private.session_state st where not exists (select 1 from auth.sessions s where s.id = st.session_id)), 0,
  'a signed-out session records none');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select app.touch_my_session('Atlas', null, null, null, pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('touch'), '203.0.113.99'));
select pg_temp.as_platform();
select is((select count(*)::int from private.session_state where pass_address = '203.0.113.99'), 0,
  'an attestation signed for another person and session gives nobody a pass');
select pg_temp.as_anon();
select throws_ok($$select app.touch_my_session('Atlas', null, null, null)$$, '42501', null, 'anon cannot touch');

-- The step-up check ------------------------------------------------------------------------------------------------------------

select pg_temp.gate_all('off');
select pg_temp.as_session('alice', 'aal2', interval '10 minutes', p_row => false);
select lives_ok($$select pg_temp.private_text('select private.require_second_factor(''create an API key'')::text')$$,
  'off: a second-factor session whose row is gone steps up as before');
select pg_temp.gate('ended', 'observe');
select lives_ok($$select pg_temp.private_text('select private.require_second_factor(''create an API key'')::text')$$,
  'ended observe: it still does');
select pg_temp.gate('ended', 'enforce');
select throws_ok($$select pg_temp.private_text('select private.require_second_factor(''create an API key'')::text')$$, 'XR001',
  'session_ended: This session was signed out. Sign in again to create an API key.',
  'ended enforce: a session with no live row cannot step up');
select throws_ok($$select * from app.create_api_key(pg_temp.id('org_a'), 'Payroll sync', array['crew'], now() + interval '30 days')$$, 'XR001',
  'session_ended: This session was signed out. Sign in again to create an API key.',
  'ended enforce: a step-up function refuses the signed-out session at aal2');
select pg_temp.as_session('alice', 'aal2', interval '10 minutes');
select lives_ok($$select pg_temp.private_text('select private.require_second_factor(''create an API key'')::text')$$,
  'ended enforce: a live second-factor session steps up');
select pg_temp.as_session('alice', 'aal1', interval '10 minutes');
select throws_ok($$select pg_temp.private_text('select private.require_second_factor(''create an API key'')::text')$$, 'XR001',
  'step_up_required: Confirm it is you with your second factor to create an API key.', 'ended enforce: a single-factor session is asked to verify, as before');
select pg_temp.gate('ended', 'off');
select pg_temp.gate_org('org_a', 'ended', 'enforce');
select pg_temp.as_session('alice', 'aal2', interval '10 minutes', p_row => false);
select throws_ok($$select pg_temp.private_text('select private.require_second_factor(''create an API key'')::text')$$, 'XR001', null,
  'ended enforced for one of the person''s organizations: the signed-out session cannot step up');
select pg_temp.gate_org('org_a', 'ended', null);

-- Asking for a second factor needs one ------------------------------------------------------------------------------------------

select pg_temp.gate_all('off');
select pg_temp.rule('org_a', 'alice', 'security.mfa_policy', 'optional');
select pg_temp.as_session('alice', 'aal1', interval '10 minutes');
select lives_ok($$select app.set_setting(pg_temp.id('org_a'), 'security.mfa_policy', 'Organization', null, 'everyone', null, null, false)$$,
  'off: an Owner at aal1 turns the policy on, as before');
select pg_temp.rule('org_a', 'alice', 'security.mfa_policy', 'optional');
select pg_temp.gate('mfa', 'observe');
select pg_temp.as_session('alice', 'aal1', interval '10 minutes');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'security.mfa_policy', 'Organization', null, 'everyone', null, null, false)$$, 'XR001',
  'step_up_required: Confirm it is you with your second factor to require a second factor in this organization.',
  'mfa observe: an Owner at aal1 cannot ask everyone for a second factor');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'security.mfa_policy', 'Organization', null, 'admins', null, null, false)$$, 'XR001', null,
  'mfa observe: nor the admins');
select lives_ok($$select app.set_setting(pg_temp.id('org_a'), 'security.mfa_policy', 'Organization', null, 'optional', null, null, false)$$,
  'mfa observe: saving optional needs no second factor');
select pg_temp.as_session('alice', 'aal2', interval '2 hours', p_second_ago => interval '90 minutes');
select lives_ok($$select app.set_setting(pg_temp.id('org_a'), 'security.mfa_policy', 'Organization', null, 'everyone', null, null, false)$$,
  'mfa observe: an Owner whose session passed a second factor turns the policy on');
select lives_ok($$select app.set_setting(pg_temp.id('org_a'), 'security.mfa_policy', 'Organization', null, 'everyone', null, null, false)$$,
  'saving the same value again asks nothing new');
select pg_temp.gate('mfa', 'off');
select pg_temp.gate_org('org_a', 'mfa', 'enforce');
select pg_temp.rule('org_a', 'alice', 'security.mfa_policy', 'optional');
select pg_temp.as_session('alice', 'aal1', interval '10 minutes');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'security.mfa_policy', 'Organization', null, 'everyone', null, null, false)$$, 'XR001', null,
  'mfa enforced for one organization: its Owner at aal1 is refused');
select pg_temp.as_session('xavier', 'aal1', interval '10 minutes');
select lives_ok($$select app.set_setting(pg_temp.id('org_b'), 'security.mfa_policy', 'Organization', null, 'everyone', null, null, false)$$,
  'while an Owner of an organization whose control is off is not asked');
select pg_temp.as_platform();
select lives_ok(format($$update app.setting_values set value_text = 'admins' where org_id = %L and setting_key = 'security.mfa_policy' and deleted_at is null$$,
  pg_temp.id('org_a')), 'a platform process is never asked');
select pg_temp.gate_org('org_a', 'mfa', null);

-- Twins in policies ------------------------------------------------------------------------------------------------------------

select is_empty($$select distinct p.schemaname || '.' || p.tablename from pg_policies p
                  where (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~ '(my_org_ids_base|my_membership_ids_base|person_capability_reach_base)'
                    and p.schemaname || '.' || p.tablename not in ('app.organizations', 'app.memberships')$$,
  'no policy reads a twin, except on app.organizations and app.memberships where ADR 0169 D6 allows it');
select ok(has_function_privilege('authenticated', 'private.my_org_ids_base()', 'execute')
  and has_function_privilege('authenticated', 'private.my_membership_ids_base()', 'execute')
  and not has_function_privilege('authenticated', 'private.person_capability_reach_base(uuid, uuid, text, boolean)', 'execute')
  and not has_function_privilege('anon', 'private.my_org_ids_base()', 'execute'),
  'the twins carry the grants of the helpers they copy');

select * from finish();
rollback;
