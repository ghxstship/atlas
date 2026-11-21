-- pgTAP: migrations 904180201 and 904180202, the session verdict (ADR 0169 work package 2, RRR-243). The gate ships
-- with every control off and then refuses nothing. For each control: off, observe and enforce, and its reason.
-- Missing claims fail closed. API keys are told apart before any amr timestamp is read. A worker claim is skipped,
-- the automation worker's token without it is signed out, and the token of a deleted account is signed out. The
-- address comes from the attestation, then the edge on a direct REST call, then the five-minute pass. Several
-- organizations: each is judged by its own rules and the strictest governs a direct call. An organization's own
-- mode overrides the global one, and a support override suspends one control until it expires. A stored verdict
-- is read once per request and never under another token. What observe records carries no personal data.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql
\ir 904180200_session_gate_fixture.psql

select plan(136);

-- As shipped ------------------------------------------------------------------------------------------------------------------

select pg_temp.as_platform();
select results_eq($$select ended, mfa, lifetime, idle, network, address_source, org_modes, suspensions from private.session_gate_config$$,
  $$values ('off', 'off', 'off', 'off', 'off', 'pass', false, false)$$,
  'the gate ships with every control off, the address source pass and no organization mode or override');
select is((select count(*)::int from private.session_gate_orgs) + (select count(*)::int from private.session_gate_overrides), 0,
  'no organization is in observe or enforce and nothing is suspended');
select throws_ok($$delete from private.session_gate_config$$, 'XR001', null, 'the configuration row cannot be deleted');
select throws_ok($$insert into private.session_gate_config (singleton) values (false)$$, '23514', null, 'and there is never a second row');
select throws_ok($$update private.session_gate_config set mfa = 'on'$$, '23514', null, 'a mode is off, observe or enforce');

-- Rules that every later case leans on: Northwind Live asks everyone for a second factor, ends a session after 8
-- hours and after 15 idle minutes, and lists one network. Harbor Lights set nothing.
select pg_temp.rule('org_a', 'alice', 'security.mfa_policy', 'everyone');
select pg_temp.rule('org_a', 'alice', 'security.session_hours', p_integer => 8);
select pg_temp.rule('org_a', 'alice', 'security.idle_timeout_minutes', p_integer => 15);
select pg_temp.allow_network('org_a', 'alice', '203.0.113.0/24');

select results_eq($$select mfa_policy, session_hours, idle_timeout_minutes, ip_allowlist from private.org_session_rules where org_id = pg_temp.id('org_a')$$,
  $$values ('everyone', 8, 15, true)$$, 'the triggers keep the organization''s rules row current');
select is((select count(*)::int from private.org_session_rules where org_id = pg_temp.id('org_b')), 0,
  'an organization that set nothing has no row');

-- A session that breaks every rule of Northwind Live, with every control off.
select pg_temp.as_session('dave', 'aal1', interval '9 hours', interval '20 minutes', p_row => false);
select is(pg_temp.verdict(), '{"v": 1, "token": "none", "session": null, "orgs": {}, "observed": []}'::jsonb,
  'off: a signed-out, single-factor, expired and idle session outside the network gets the empty verdict');
select is(pg_temp.private_text($$select count(*) from private.session_refused_org_ids()$$), '0', 'off: no organization refuses');
select is(pg_temp.private_text($$select private.session_direct_refusal()$$), null, 'off: a direct call is not refused');

-- Who is skipped --------------------------------------------------------------------------------------------------------------

select pg_temp.gate_all('enforce');
select pg_temp.as_platform();
select is(pg_temp.verdict() ->> 'token', 'none', 'enforce: a request with no token is skipped');
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select is(pg_temp.verdict() -> 'orgs', '{}'::jsonb, 'enforce: service_role is skipped');
select pg_temp.as_anon();
select is(pg_temp.verdict() ->> 'session', null, 'enforce: anon is skipped');
select pg_temp.token(jsonb_build_object('sub', pg_temp.id('alice_user'), 'role', 'authenticated', 'xos_automation_run_id', gen_random_uuid(),
  'xos_origin', 'worker'));
select is(pg_temp.verdict(), '{"v": 1, "token": "worker", "session": null, "orgs": {}, "observed": []}'::jsonb,
  'enforce: a worker token (claim xos_origin = worker) is outside every rule');
-- ADR 0169, "What package 1 hands to the packages after it", item 1: the automation worker's token as it is minted
-- today (1481_automation_runs.test.sql) names no session. It is signed out until package 8 adds the worker claim.
select pg_temp.token(jsonb_build_object('sub', pg_temp.id('alice_user'), 'role', 'authenticated', 'xos_automation_run_id', gen_random_uuid()));
select is(pg_temp.verdict() ->> 'session', 'session_ended',
  'enforce: the automation worker''s token without the worker claim is refused as signed out');

-- The signed-out control ------------------------------------------------------------------------------------------------------

select pg_temp.gate_all('off');
select pg_temp.as_session('nina', p_row => false);
select pg_temp.gate('ended', 'observe');
select is(pg_temp.verdict() ->> 'session', null, 'ended observe: a signed-out session is not refused');
select is(pg_temp.verdict() -> 'observed', '[{"org": null, "control": "ended", "reason": "session_ended"}]'::jsonb,
  'ended observe: it is recorded as a session enforce would refuse');
select pg_temp.gate('ended', 'enforce');
select is(pg_temp.verdict() ->> 'session', 'session_ended', 'ended enforce: a session whose auth.sessions row is gone is refused as a whole');
select pg_temp.as_session('nina');
select is(pg_temp.verdict() ->> 'session', null, 'ended enforce: a live session of a person with no organization passes');
select pg_temp.as_session('nina', p_without => array['session_id']);
select is(pg_temp.verdict() ->> 'session', 'session_ended', 'ended enforce: a token with no session_id claim is refused');
select pg_temp.as_session('nina', p_without => array['amr']);
select is(pg_temp.verdict() ->> 'session', 'session_ended', 'ended enforce: a token with no amr timestamp is refused');
select pg_temp.token(jsonb_build_object('role', 'authenticated', 'aal', 'aal1', 'session_id', gen_random_uuid(),
  'amr', pg_temp.amr('password', interval '5 minutes')));
select is(pg_temp.verdict() ->> 'session', 'session_ended', 'ended enforce: a token that names no person is refused');
insert into world values ('timed_out', pg_temp.as_session('nina'));
select pg_temp.as_owner_of_gate(format($$update auth.sessions set not_after = now() - interval '1 minute' where id = %L$$, pg_temp.id('timed_out')));
select is(pg_temp.verdict() ->> 'session', 'session_ended', 'ended enforce: a session past the end Supabase Auth set for it is refused');
select pg_temp.as_session('dave', 'aal2', interval '10 minutes', p_row => false);
select is(pg_temp.org_reasons('org_a'), 'session_ended', 'ended enforce: every organization of the person refuses a signed-out session');
select is(pg_temp.private_text($$select private.session_ended_refused()::text$$), 'true', 'and the step-up check is told so');
-- ADR 0169, "What package 1 hands to the packages after it", item 3: the token that outlived its account.
select pg_temp.token_of_deleted_account(gen_random_uuid());
select is(pg_temp.verdict() ->> 'session', 'session_ended', 'ended enforce: the token of a deleted account is refused as signed out');
select is(pg_temp.private_text($$select private.session_gate_reachable('app', 'delete_my_account', false)::text$$), 'false',
  'and app.delete_my_account is not among the functions a refused session reaches on a direct call');

-- The second-factor control ---------------------------------------------------------------------------------------------------

select pg_temp.gate_all('off');
select pg_temp.as_session('dave', 'aal1', interval '10 minutes');
select pg_temp.gate('mfa', 'observe');
select is(pg_temp.org_reasons('org_a'), null, 'mfa observe: a single-factor session is not refused');
select is(pg_temp.verdict() -> 'observed' -> 0 ->> 'reason', 'session_mfa_required', 'mfa observe: it is recorded');
select pg_temp.gate('mfa', 'enforce');
select is(pg_temp.org_reasons('org_a'), 'session_mfa_required', 'mfa enforce: a single-factor session is refused where everyone must verify');
select is(pg_temp.verdict() ->> 'session', null, 'mfa enforce: the session itself is not refused as a whole');
select pg_temp.as_session('dave', 'aal2', interval '10 minutes');
select is(pg_temp.org_reasons('org_a'), null, 'mfa enforce: a session that passed a second factor passes');
select pg_temp.as_session('dave', 'aal2', interval '10 minutes', p_without => array['aal']);
select is(pg_temp.org_reasons('org_a'), 'session_mfa_required', 'mfa enforce: a token with no aal claim is not aal2');
select pg_temp.rule('org_a', 'alice', 'security.mfa_policy', 'admins');
select pg_temp.as_session('dave', 'aal1', interval '10 minutes');
select is(pg_temp.org_reasons('org_a'), null, 'mfa enforce, admins: a Member is not asked');
select pg_temp.as_session('bob', 'aal1', interval '10 minutes');
select is(pg_temp.org_reasons('org_a'), 'session_mfa_required', 'mfa enforce, admins: an Admin is');
select pg_temp.rule('org_a', 'alice', 'security.mfa_policy', 'everyone');

-- The lifetime control --------------------------------------------------------------------------------------------------------

select pg_temp.gate_all('off');
select pg_temp.as_session('dave', 'aal2', interval '9 hours');
select pg_temp.gate('lifetime', 'observe');
select is(pg_temp.org_reasons('org_a'), null, 'lifetime observe: an old session is not refused');
select is(pg_temp.verdict() -> 'observed' -> 0 ->> 'reason', 'session_expired', 'lifetime observe: it is recorded');
select pg_temp.gate('lifetime', 'enforce');
select is(pg_temp.org_reasons('org_a'), 'session_expired', 'lifetime enforce: a session older than the organization''s 8 hours is refused');
select pg_temp.as_session('dave', 'aal2', interval '7 hours');
select is(pg_temp.org_reasons('org_a'), null, 'lifetime enforce: a 7-hour session passes');
select pg_temp.as_session('dave', 'aal2', interval '10 minutes', p_without => array['amr']);
select is(pg_temp.org_reasons('org_a'), 'session_expired', 'lifetime enforce: with no sign-in time in the token the session counts as expired');
select pg_temp.as_session('xavier', 'aal1', interval '9 hours');
select is(pg_temp.org_reasons('org_b'), null, 'lifetime enforce: an organization that set nothing gives the default 336 hours');
select pg_temp.as_session('xavier', 'aal1', interval '337 hours');
select is(pg_temp.org_reasons('org_b'), 'session_expired', 'and refuses past them');

-- The idle control ------------------------------------------------------------------------------------------------------------

select pg_temp.gate_all('off');
select pg_temp.as_session('dave', 'aal2', interval '30 minutes', interval '20 minutes');
select pg_temp.gate('idle', 'observe');
select is(pg_temp.org_reasons('org_a'), null, 'idle observe: an idle session is not refused');
select is(pg_temp.verdict() -> 'observed' -> 0 ->> 'reason', 'session_idle', 'idle observe: it is recorded');
select pg_temp.gate('idle', 'enforce');
select is(pg_temp.org_reasons('org_a'), 'session_idle', 'idle enforce: 20 minutes since the last activity is past the organization''s 15');
insert into world values ('active', pg_temp.as_session('dave', 'aal2', interval '10 minutes', interval '5 minutes'));
select is(pg_temp.org_reasons('org_a'), null, 'idle enforce: a session active 5 minutes ago passes');
-- A token refresh is one activity: the gap from the last recorded activity to it counts.
insert into world values ('refreshed', pg_temp.as_session('dave', 'aal2', interval '50 minutes', interval '10 minutes'));
select is(pg_temp.org_reasons('org_a'), 'session_idle', 'idle enforce: 40 minutes between the sign-in and the next token refresh is a gap');
select pg_temp.session_state(pg_temp.id('refreshed'), interval '12 minutes', interval '6 minutes');
select is(pg_temp.org_reasons('org_a'), null, 'idle enforce: with an activity recorded every few minutes the same session passes');
-- The longest gap is kept: activity after the timeout does not revive the session.
select pg_temp.session_state(pg_temp.id('refreshed'), interval '1 minute', interval '16 minutes');
select is(pg_temp.org_reasons('org_a'), 'session_idle', 'idle enforce: a past gap of 16 minutes keeps the session idle after it is active again');
select pg_temp.as_session('dave', 'aal2', interval '10 minutes', p_row => false);
select is(pg_temp.org_reasons('org_a'), 'session_idle', 'idle enforce: with no session row to read, the session counts as idle');
select pg_temp.as_session('xavier', 'aal1', interval '59 minutes', interval '0');
select is(pg_temp.org_reasons('org_b'), null, 'idle enforce: an organization that set nothing gives the default 60 minutes');
select pg_temp.as_platform();
select is(private.session_idle_span(now() - interval '2 hours', null, null, null, now()), interval '2 hours',
  'the idle span of a session never recorded and never refreshed is its age');
select is(private.session_idle_span(now() - interval '2 hours', now() - interval '30 minutes', now() - interval '50 minutes', interval '5 minutes', now()),
  interval '30 minutes', 'the idle span is the greatest of the kept gap, the gap to the refresh and the time since');

-- The network control ---------------------------------------------------------------------------------------------------------

select pg_temp.gate_all('off');
insert into world values ('net', pg_temp.as_session('dave', 'aal2', interval '10 minutes'));
select pg_temp.gate('network', 'observe');
select is(pg_temp.org_reasons('org_a'), null, 'network observe: a session with no pass is not refused');
select is(pg_temp.verdict() -> 'observed' -> 0 ->> 'reason', 'network_restricted', 'network observe: it is recorded');
select pg_temp.gate('network', 'enforce');
select is(pg_temp.org_reasons('org_a'), 'network_restricted', 'network enforce, pass: a session no server saw inside the list is refused');
select pg_temp.session_state(pg_temp.id('net'), p_pass_address => '203.0.113.40', p_pass_age => interval '4 minutes');
select is(pg_temp.org_reasons('org_a'), null, 'network enforce, pass: a 4-minute-old pass inside the list admits the session');
select pg_temp.session_state(pg_temp.id('net'), p_pass_address => '203.0.113.40', p_pass_age => interval '6 minutes');
select is(pg_temp.org_reasons('org_a'), 'network_restricted', 'network enforce, pass: a pass older than five minutes does not');
select pg_temp.session_state(pg_temp.id('net'), p_pass_address => '198.51.100.7', p_pass_age => interval '1 minute');
select is(pg_temp.org_reasons('org_a'), 'network_restricted', 'network enforce, pass: nor does a fresh pass outside the list');

-- The attested address comes first and is exact.
select pg_temp.request_headers(jsonb_build_object('x-xos-attestation',
  pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('net'), '203.0.113.9')));
select is(pg_temp.org_reasons('org_a'), null, 'network enforce: an attested address inside the list admits the call, whatever the pass says');
select pg_temp.session_state(pg_temp.id('net'), p_pass_address => '203.0.113.40', p_pass_age => interval '1 minute');
select pg_temp.request_headers(jsonb_build_object('x-xos-attestation',
  pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('net'), '198.51.100.7')));
select is(pg_temp.org_reasons('org_a'), 'network_restricted', 'network enforce: an attested address outside the list refuses it, whatever the pass says');
select pg_temp.request_headers(jsonb_build_object('x-xos-attestation',
  pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('net'), null)));
select is(pg_temp.org_reasons('org_a'), 'network_restricted', 'network enforce: an attestation that knows no address refuses it');
select pg_temp.request_headers(jsonb_build_object('x-xos-attestation',
  pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('net'), '203.0.113.9', p_key => repeat('0', 64))));
select is(pg_temp.org_reasons('org_a'), null, 'network enforce: a forged attestation is no attestation, and the call falls back to its pass');

-- The edge address: only on a direct REST call, only when the address source says so (probe of 2026-11-21:
-- xos.trusted_proxy_hops = 0, the gateway appends, a client-sent entry stays on the left).
select pg_temp.session_state(pg_temp.id('net'));
select pg_temp.request_headers('{"x-forwarded-for": "198.51.100.7, 203.0.113.40"}');
select is(pg_temp.org_reasons('org_a', 'postgrest'), 'network_restricted', 'network enforce, pass: the edge address is not read while the source is pass');
select pg_temp.address_source('edge');
select is(pg_temp.org_reasons('org_a', 'postgrest'), null, 'network enforce, edge: a direct REST call from inside the list passes with no pass');
select is(pg_temp.org_reasons('org_a'), 'network_restricted', 'network enforce, edge: off the REST surface the pass still decides');
select pg_temp.request_headers('{"x-forwarded-for": "203.0.113.40, 198.51.100.7"}');
select is(pg_temp.org_reasons('org_a', 'postgrest'), 'network_restricted', 'network enforce, edge: an entry the client wrote on the left admits nobody');
select pg_temp.request_headers('{"x-forwarded-for": "198.51.100.7, ::ffff:203.0.113.40"}');
select is(pg_temp.org_reasons('org_a', 'postgrest'), null, 'network enforce, edge: an IPv4 client seen through IPv6 is compared as IPv4');
select pg_temp.request_headers(null);
select is(pg_temp.org_reasons('org_a', 'postgrest'), 'network_restricted', 'network enforce, edge: a request with no address is refused');
select pg_temp.address_source('pass');

-- Break-glass at aal2 from outside the list.
select pg_temp.as_session('alice', 'aal2', interval '10 minutes');
select is(pg_temp.org_reasons('org_a'), 'network_restricted', 'network enforce: an Owner outside the list is refused');
select lives_ok($$select app.start_break_glass(pg_temp.id('org_a'), 'The office network is down during load-in and payroll must run.')$$,
  'the Owner takes emergency access at aal2');
select is(pg_temp.org_reasons('org_a'), null, 'network enforce: the Owner''s open break-glass session at aal2 lifts the allow-list');
select pg_temp.as_session('alice', 'aal1', interval '10 minutes');
select is(pg_temp.org_reasons('org_a'), 'network_restricted', 'but not for a single-factor session of the same Owner');

-- API keys, apps and people who are no members -------------------------------------------------------------------------------

select pg_temp.gate_all('enforce');
-- ADR 0169, "What package 1 hands to the packages after it", item 2: nine suites present timestamp 0 and one none.
select pg_temp.token(jsonb_build_object('sub', pg_temp.id('xavier_user'), 'role', 'authenticated', 'scopes', jsonb_build_array('data'),
  'amr', jsonb_build_array(jsonb_build_object('method', 'xos_api_key', 'timestamp', 0))));
select is(pg_temp.verdict(), '{"v": 1, "token": "api_key", "session": null, "orgs": {}, "observed": []}'::jsonb,
  'enforce: an API-key token with timestamp 0 is exempt from the signed-out, second-factor, lifetime and idle rules');
select pg_temp.token(jsonb_build_object('sub', pg_temp.id('xavier_user'), 'role', 'authenticated', 'scopes', jsonb_build_array('data'),
  'amr', jsonb_build_array(jsonb_build_object('method', 'xos_api_key'))));
select is(pg_temp.verdict(), '{"v": 1, "token": "api_key", "session": null, "orgs": {}, "observed": []}'::jsonb,
  'enforce: and so is an API-key token with no timestamp at all');
select pg_temp.token(jsonb_build_object('sub', pg_temp.id('dave_user'), 'role', 'authenticated', 'scopes', jsonb_build_array('data'),
  'amr', jsonb_build_array(jsonb_build_object('method', 'xos_api_key', 'timestamp', 0))));
select is(pg_temp.org_reasons('org_a'), 'network_restricted', 'enforce, pass: an API key holds no pass and is refused for an organization with an allow-list');
select pg_temp.address_source('edge');
select pg_temp.request_headers('{"x-forwarded-for": "203.0.113.40"}');
select is(pg_temp.org_reasons('org_a', 'postgrest'), null, 'enforce, edge: an API key on a direct REST call from a listed network passes');
select pg_temp.address_source('pass');
select pg_temp.request_headers(jsonb_build_object('x-xos-attestation', pg_temp.attestation(pg_temp.id('dave_user'), null, '203.0.113.40')));
select is(pg_temp.org_reasons('org_a'), null, 'enforce: an API key through our servers is checked on the attested address');
select pg_temp.request_headers(null);

-- An OAuth app token (claim client_id): not a session, but it needs a live session row.
select pg_temp.token(jsonb_build_object('sub', pg_temp.id('xavier_user'), 'role', 'authenticated', 'aal', 'aal1',
  'client_id', gen_random_uuid(), 'session_id', gen_random_uuid()));
select is(pg_temp.verdict() ->> 'session', 'session_ended', 'enforce: an app token with no live session row is refused');
select is(pg_temp.verdict() ->> 'token', 'app', 'and is known as an app token');

-- A person who is no member follows no organization's rules; only the signed-out rule applies.
select pg_temp.as_session('nina', 'aal1', interval '400 hours', interval '50 minutes');
select is(pg_temp.verdict(), '{"v": 1, "token": "session", "session": null, "orgs": {}, "observed": []}'::jsonb,
  'enforce: a person with no organization is bound by no lifetime, idle, second-factor or network rule');
select pg_temp.as_session('xavier', 'aal1', interval '10 minutes');
select is(pg_temp.org_reasons('org_a'), null, 'enforce: Northwind''s rules do not reach a member of Harbor Lights only');

-- Several organizations ---------------------------------------------------------------------------------------------------------

-- Mia is a member of Northwind Live (strict) and of Harbor Lights (nothing set).
select pg_temp.gate_all('enforce');
select pg_temp.gate('network', 'off');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select is(pg_temp.org_reasons('org_a'), 'session_mfa_required', 'two organizations: the one that asks for a second factor refuses');
select is(pg_temp.org_reasons('org_b'), null, 'two organizations: the one with no rules admits the same session');
select is(pg_temp.private_text($$select string_agg(o::text, ',') from private.session_refused_org_ids() o$$), pg_temp.id('org_a')::text,
  'the refused set names the refusing organization alone');
select is(pg_temp.private_text($$select private.session_direct_refusal()$$), 'session_mfa_required',
  'on a direct call the strictest organization governs: the call is refused with its reason');
select is(pg_temp.private_text(format($$select private.session_org_refusal(%L)$$, pg_temp.id('org_b'))), null,
  'through our servers the admitting organization stays open');
select pg_temp.rule('org_b', 'xavier', 'security.idle_timeout_minutes', p_integer => 5);
select pg_temp.as_session('mia', 'aal1', interval '9 hours', interval '6 minutes');
select is(pg_temp.org_reasons('org_a'), 'session_expired,session_idle,session_mfa_required',
  'different rules: Northwind refuses for the lifetime, the idle time and the second factor, strongest reason first');
select is(pg_temp.org_reasons('org_b'), 'session_idle', 'different rules: Harbor Lights refuses for its own 5 idle minutes');
select is(pg_temp.private_text($$select private.session_direct_refusal()$$), 'session_expired',
  'and the direct call is refused with the strongest reason of all');

-- Modes ------------------------------------------------------------------------------------------------------------------------

select pg_temp.gate_all('off');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select pg_temp.gate_org('org_a', 'mfa', 'enforce');
select is(pg_temp.private_text($$select org_modes::text from private.session_gate_config$$), 'true', 'an organization mode sets the flag on the configuration row');
select is(pg_temp.org_reasons('org_a'), 'session_mfa_required', 'an organization''s own enforce overrides the global off');
select pg_temp.gate('mfa', 'enforce');
select pg_temp.gate_org('org_a', 'mfa', 'observe');
select is(pg_temp.org_reasons('org_a'), null, 'an organization''s own observe overrides the global enforce');
select is(pg_temp.verdict() -> 'observed' -> 0 ->> 'control', 'mfa', 'and it is recorded instead');
select pg_temp.gate_org('org_a', 'mfa', 'off');
select is(pg_temp.verdict() -> 'observed', '[]'::jsonb, 'an organization''s own off overrides the global enforce');
select pg_temp.gate_org('org_a', 'mfa', null);
select is(pg_temp.private_text($$select org_modes::text from private.session_gate_config$$), 'false', 'removing the last organization mode clears the flag');
select is(pg_temp.org_reasons('org_a'), 'session_mfa_required', 'without its own mode the organization follows the global enforce');
select is(pg_temp.private_text(format($$select private.session_gate_mode(%L, 'mfa')$$, pg_temp.id('org_a'))), 'enforce',
  'private.session_gate_mode reads the mode in force');

-- A support override suspends one control for one organization and expires.
select pg_temp.as_platform();
select throws_ok(format($$insert into private.session_gate_overrides (org_id, control, actor, reason, expires_at)
  values (%L, 'mfa', 'support: pgTAP', 'Every Owner lost their authenticator during the tour.', now() + interval '25 hours')$$, pg_temp.id('org_a')),
  '23514', null, 'an override lasts at most 24 hours');
select throws_ok(format($$insert into private.session_gate_overrides (org_id, control, actor, reason, expires_at)
  values (%L, 'mfa', 'support: pgTAP', 'Too short.', now() + interval '1 hour')$$, pg_temp.id('org_a')),
  '23514', null, 'and states its reason in at least 20 characters');
insert into private.session_gate_overrides (org_id, control, actor, reason, expires_at)
values (pg_temp.id('org_a'), 'mfa', 'support: pgTAP', 'Every Owner lost their authenticator during the tour.', now() + interval '2 hours');
select is((select suspensions from private.session_gate_config), true, 'an override sets the flag on the configuration row');
select is((select count(*)::int from app.audit_events e where e.action = 'session_gate_overrides.started' and e.org_id = pg_temp.id('org_a')
           and e.diff ->> 'actor' = 'support: pgTAP'), 1, 'the override is written to the organization''s audit ledger with its actor');
select pg_temp.gate('lifetime', 'enforce');
select pg_temp.as_session('mia', 'aal1', interval '9 hours');
select is(pg_temp.org_reasons('org_a'), 'session_expired', 'the override suspends the second-factor control and no other');
select pg_temp.as_platform();
select throws_ok($$update private.session_gate_overrides set reason = 'A different reason, written afterwards.'$$, 'XR001', null,
  'an override is never rewritten');
update private.session_gate_overrides set ended_at = now();
select is((select suspensions from private.session_gate_config), false, 'ending the override clears the flag');
select pg_temp.as_session('mia', 'aal1', interval '9 hours');
select is(pg_temp.org_reasons('org_a'), 'session_expired,session_mfa_required', 'an ended override suspends nothing');
select pg_temp.as_platform();
insert into private.session_gate_overrides (org_id, control, actor, reason, starts_at, expires_at)
values (pg_temp.id('org_a'), 'mfa', 'support: pgTAP', 'Every Owner lost their authenticator during the tour.', now() - interval '3 hours', now() - interval '1 hour');
select pg_temp.as_session('mia', 'aal1', interval '9 hours');
select is(pg_temp.org_reasons('org_a'), 'session_expired,session_mfa_required', 'an expired override suspends nothing');

-- One verdict per request ------------------------------------------------------------------------------------------------------

select pg_temp.gate_all('off');
select pg_temp.gate('mfa', 'enforce');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select is(pg_temp.private_text($$select (private.session_verdict_store('postgrest') ? 'k')::text$$), 'true',
  'the pre-request stores the verdict for the request');
select pg_temp.gate('mfa', 'off');
select is(pg_temp.private_text($$select private.session_direct_refusal()$$), 'session_mfa_required',
  'every reader reads the stored verdict: a later change of the configuration does not reach this request');
select is(pg_temp.private_text($$select private.session_verdict_compute(null) -> 'orgs'$$), '{}',
  'while a fresh computation sees the change');
select pg_temp.as_session('dave', 'aal2', interval '10 minutes');
select is(pg_temp.private_text($$select private.session_direct_refusal()$$), null,
  'a stored verdict is never read under another token');

-- Plan shape (ADR 0169 D9) ------------------------------------------------------------------------------------------------------
-- In the style of 0943_rls_benchmark_fixes.test.sql: a policy reads the refused set as an array, so the planner
-- evaluates it once per statement as an InitPlan and never once per row.

create function pg_temp.plan_of(p_sql text) returns text
language plpgsql as $$
declare
  v_role text := current_setting('role');
  v_line text;
  v_plan text := '';
begin
  perform set_config('role', 'postgres', true);
  for v_line in execute 'explain (costs off) ' || p_sql loop
    v_plan := v_plan || v_line || E'\n';
  end loop;
  perform set_config('role', v_role, true);
  return v_plan;
end $$;

select ok(pg_temp.plan_of($$select m.id from app.memberships m where m.org_id <> all (array(select private.session_refused_org_ids()))$$)
            ~ 'Filter: [^\n]*InitPlan 1',
  'the refused set, read as org_id <> all (array(select ...)), is an InitPlan the row filter refers to');
select ok(pg_temp.plan_of($$select m.id from app.memberships m where m.org_id <> all (array(select private.session_refused_org_ids()))$$)
            !~ 'SubPlan|Filter: [^\n]*session_refused_org_ids',
  'and it appears nowhere else: no SubPlan and no call in the row filter itself');
select pg_temp.as_platform();
select ok((select p.prosrc from pg_proc p where p.oid = 'private.session_verdict()'::regprocedure) ~ 'current_setting\(''xos.session_verdict'', true\)'
  and (select p.provolatile from pg_proc p where p.oid = 'private.session_refused_org_ids()'::regprocedure) = 's',
  'the readers are stable and read the transaction-local setting xos.session_verdict before they compute');

-- What a refused session still reaches ----------------------------------------------------------------------------------------

select pg_temp.as_platform();
select is_empty($$select f from unnest(private.session_gate_open_functions()) f
  where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = f)$$,
  'every function on the recovery list exists in the app schema');
select is(private.session_gate_open_functions(), array['my_session_gate', 'my_org_auth_status', 'network_access', 'redeem_recovery_code',
  'touch_my_session', 'my_sessions', 'sign_out_my_session', 'sign_out_my_other_sessions', 'start_break_glass', 'ensure_my_profile'],
  'the recovery list is the one ADR 0169 D2 names');
select ok(private.session_gate_reachable('app', 'my_session_gate', false) and private.session_gate_reachable('app', 'redeem_recovery_code', false),
  'a session an organization refuses reaches the recovery functions');
select ok(not private.session_gate_reachable('app', 'my_session_gate', true) and not private.session_gate_reachable('app', 'my_sessions', null),
  'a session refused as a whole does not');
select ok(private.session_gate_reachable('api_public', 'anything', true) and private.session_gate_reachable('api_public', null, true),
  'both reach the api_public schema');
select ok(not private.session_gate_reachable('app', 'workforce_directory', false) and not private.session_gate_reachable('app', null, false)
  and not private.session_gate_reachable('xpms', 'my_session_gate', false) and not private.session_gate_reachable(null, 'my_session_gate', false),
  'and nothing else: no other function, no table, no other schema');

-- Grants and shape ---------------------------------------------------------------------------------------------------------------

select is_empty($$select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and (p.proname like 'session\_%' or p.proname like '%attestation%' or p.proname like '%session\_gate%'
        or p.proname in ('stamp_session_activity', 'refresh_org_session_rules', 'keep_org_session_rules'))
    and (has_function_privilege('anon', p.oid, 'execute')
      or (has_function_privilege('authenticated', p.oid, 'execute')
          and p.proname not in ('session_verdict', 'session_refusal', 'session_refused_org_ids', 'session_org_refusal')))$$,
  'no gate function is executable by anon, and a signed-in role may run only the four readers that policies call');
select is_empty($$select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname in ('session_verdict', 'session_verdict_compute', 'session_verdict_store', 'session_gate_observe',
        'session_gate_mode', 'session_refusal', 'session_refused_org_ids', 'session_org_refusal', 'session_direct_refusal', 'session_ended_refused')
    and not (p.prosecdef and p.proconfig @> array['search_path=""'])$$,
  'the verdict and its readers run with owner rights and an empty search path');
select is((select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
           where a.attrelid = 'private.session_gate_observations'::regclass and a.attnum > 0 and not a.attisdropped),
  'id,observed_on,control,surface,org_id,token_type,reason,calls,first_seen_at,last_seen_at',
  'an observation holds a row id, a day, a control, a surface, an organization, a kind of token, a reason and counts: no person, session or address');

-- What observe writes ----------------------------------------------------------------------------------------------------------

select pg_temp.gate_all('off');
select pg_temp.gate('mfa', 'observe');
select pg_temp.gate('ended', 'observe');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select is(pg_temp.private_text($$select private.session_verdict_store('postgrest') ->> 'session'$$), null, 'observe: storing the verdict refuses nothing');
select pg_temp.private_text($$select private.session_verdict_store('postgrest')$$);
select pg_temp.as_platform();
select results_eq($$select control, surface, org_id, token_type, reason, calls from private.session_gate_observations$$,
  format($$values ('mfa', 'postgrest', %L::uuid, 'session', 'session_mfa_required', 2::bigint)$$, pg_temp.id('org_a')),
  'observe: two read-write calls enforce would refuse are counted in one row');
select pg_temp.as_session('nina', p_row => false);
select pg_temp.private_text($$select private.session_verdict_store('Storage API')$$);
select pg_temp.as_platform();
select results_eq($$select control, surface, org_id, token_type, reason, calls from private.session_gate_observations where control = 'ended'$$,
  $$values ('ended', 'other', null::uuid, 'session', 'session_ended', 1::bigint)$$,
  'observe: a signed-out session is counted with no organization, and a surface name that is no identifier is counted as other');
select is(private.session_gate_log_line('mfa', 'postgrest', pg_temp.id('org_a'), 'session', 'session_mfa_required') like 'xos_session_gate {%', true,
  'observe: the log line starts with the marker xos_session_gate');
select is((select array_agg(k order by k) from jsonb_object_keys(substr(
    private.session_gate_log_line('mfa', 'postgrest', pg_temp.id('org_a'), 'session', 'session_mfa_required'), 18)::jsonb) k),
  array['control', 'org_id', 'reason', 'surface', 'token'],
  'observe: the log line carries the control, surface, organization, kind of token and reason, and nothing about the person');

-- The address comparison that precedes the switch to edge (ADR 0169 D4).
delete from private.session_gate_observations;
select pg_temp.gate_all('off');
select pg_temp.gate('network', 'observe');
insert into world values ('cmp', pg_temp.as_session('dave', 'aal2', interval '10 minutes'));
select pg_temp.session_state(pg_temp.id('cmp'), p_pass_address => '203.0.113.40', p_pass_age => interval '1 minute');
select pg_temp.request_headers('{"x-forwarded-for": "203.0.113.40"}');
select is(pg_temp.verdict('postgrest') -> 'observed', '[{"org": null, "control": "network", "reason": "edge_matches_pass"}]'::jsonb,
  'network observe, pass: a direct REST call whose edge address is its pass address is recorded as agreeing');
select pg_temp.request_headers('{"x-forwarded-for": "198.51.100.7"}');
select is(pg_temp.verdict('postgrest') -> 'observed', '[{"org": null, "control": "network", "reason": "edge_differs_from_pass"}]'::jsonb,
  'network observe, pass: and as differing when it is another address');
select is(pg_temp.verdict() -> 'observed', '[]'::jsonb, 'the comparison is made on direct REST calls only');
select pg_temp.request_headers(null);

-- The rules rows stay equal to the settings they mirror -------------------------------------------------------------------------

select pg_temp.rule('org_a', 'alice', 'security.ip_allowlist', p_boolean => false);
select pg_temp.as_platform();
select is((select ip_allowlist from private.org_session_rules where org_id = pg_temp.id('org_a')), false, 'turning the allow-list off reaches the rules row');
select pg_temp.rule('org_a', 'alice', 'security.ip_allowlist', p_boolean => true);
update app.setting_values set deleted_at = now() where org_id = pg_temp.id('org_a') and setting_key = 'security.session_hours' and deleted_at is null;
select is((select session_hours from private.org_session_rules where org_id = pg_temp.id('org_a')), null, 'a removed setting reads as unset');
select is_empty($$
  select o.id from app.organizations o left join private.org_session_rules r on r.org_id = o.id
  where (r.mfa_policy, r.session_hours, r.idle_timeout_minutes, coalesce(r.ip_allowlist, false)) is distinct from (
    (select v.value_text from app.setting_values v where v.org_id = o.id and v.setting_key = 'security.mfa_policy'
       and v.scope_kind = 'Organization' and v.scope_id = o.id and v.deleted_at is null),
    (select v.value_integer::integer from app.setting_values v where v.org_id = o.id and v.setting_key = 'security.session_hours'
       and v.scope_kind = 'Organization' and v.scope_id = o.id and v.deleted_at is null),
    (select v.value_integer::integer from app.setting_values v where v.org_id = o.id and v.setting_key = 'security.idle_timeout_minutes'
       and v.scope_kind = 'Organization' and v.scope_id = o.id and v.deleted_at is null),
    coalesce((select v.value_boolean from app.setting_values v where v.org_id = o.id and v.setting_key = 'security.ip_allowlist'
       and v.scope_kind = 'Organization' and v.scope_id = o.id and v.deleted_at is null), false)
      and exists (select 1 from app.org_ip_allowlist a where a.org_id = o.id and a.deleted_at is null))$$,
  'after every change in this suite, each organization''s rules row equals its settings');

-- A read-only transaction: observe logs and counts nothing, and still refuses nothing ----------------------------------------
-- Last, because a transaction cannot turn read-write again.

delete from private.session_gate_observations;
select pg_temp.gate_all('off');
select pg_temp.gate('mfa', 'observe');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
set transaction read only;
select is(pg_temp.private_text($$select private.session_verdict_store('postgrest') -> 'observed' -> 0 ->> 'reason'$$), 'session_mfa_required',
  'observe on a read-only request: the verdict is stored and names what enforce would refuse');
select is(pg_temp.private_text($$select count(*) from private.session_gate_observations$$), '0',
  'observe on a read-only request: nothing is counted, because nothing can be written');

select * from finish();
rollback;
