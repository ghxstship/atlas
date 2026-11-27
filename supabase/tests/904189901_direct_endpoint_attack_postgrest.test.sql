-- pgTAP: the attacker's test, REST surface (ADR 0169 "Test plan"; release 4.18, block 99; RRR-243). A member of an
-- organization that sets a rule holds a session that breaks it and calls the data endpoint directly: reads a
-- project list, inserts a record, and calls a definer function that reads app.memberships inline
-- (app.workforce_directory). The cases: a single-factor session where everyone must verify; a session older than
-- the lifetime; an idle session, also after a touch sent past the timeout; a session whose auth.sessions row is
-- gone, including a step-up function at aal2; a caller outside the allow-list, with a session token and with an
-- API-key token; a token with no session_id claim. Two more are attacks on the gate's own records: an attestation
-- lifted from one of our servers and replayed to keep or regain a network pass, and a member who holds a slow write
-- open while a control is in observe so that other members' calls wait on the observation counter. The second
-- needs two connections, which pgTAP does not have: infra/db/test/session-gate-concurrency.sh makes the two calls,
-- and this file holds that the counter is only ever taken with a lock that is tried, never waited for.
--
-- Package 2 (the gate core) created this file. What the gate core decides passes today: the verdict names the
-- refusal of every case, a signed-out session cannot step up, and a refused session still reads why. Refusing the
-- call itself is the PostgREST pre-request's work: those cases are marked todo and name work package 4, which
-- removes the marks in this file when gate.pre_request() refuses with code XS401 and the reason as hint. No case is
-- skipped. pgTAP cannot see the pre-request's registration on the authenticator role; the HTTP test proves that.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql
\ir 904180200_session_gate_fixture.psql

select plan(43);

select pg_temp.attack_rules();

create function pg_temp.read_projects() returns text
language sql as $$ select pg_temp.direct('select count(*) from app.projects', 'GET', '/projects') $$;

create function pg_temp.insert_record() returns text
language sql as $$
  select pg_temp.direct(format(
    'insert into app.records (project_id, scope_node_id, record_kind, title, phase_code, xyz, xyz_basis) values (%L, %L, %L, %L, %L, %L, %L)',
    pg_temp.id('prj_a'), pg_temp.id('root_a'), 'Task', 'Attack suite task', 'SCP', 'Y', 'Declared'), 'POST', '/records')
$$;

create function pg_temp.call_directory() returns text
language sql as $$
  select pg_temp.direct(format('select count(*) from app.workforce_directory(%L)', pg_temp.id('org_a')), 'POST', '/rpc/workforce_directory')
$$;

-- A session that meets every rule is answered: the three calls are real ones.
select pg_temp.attack('passing');
select is(pg_temp.read_projects(), 'answered', 'a session that meets every rule reads the project list');
select is(pg_temp.insert_record(), 'answered', 'and inserts a record');
select is(pg_temp.call_directory(), 'answered', 'and reads the workforce directory');

-- A single-factor session where everyone must verify ---------------------------------------------------------------------------
select pg_temp.attack('mfa');
select is(pg_temp.private_text('select private.session_direct_refusal()'), 'session_mfa_required', 'mfa: the verdict refuses the direct call');
select todo('work package 4 (the PostgREST pre-request) refuses the call: HTTP 401, code XS401, hint session_mfa_required', 3);
select is(pg_temp.read_projects(), 'XS401 session_mfa_required', 'mfa: reading a project list is refused');
select is(pg_temp.insert_record(), 'XS401 session_mfa_required', 'mfa: inserting a record is refused');
select is(pg_temp.call_directory(), 'XS401 session_mfa_required', 'mfa: a definer function that reads memberships inline is refused');

-- A session older than the organization's lifetime -----------------------------------------------------------------------------
select pg_temp.attack('lifetime');
select is(pg_temp.private_text('select private.session_direct_refusal()'), 'session_expired', 'lifetime: the verdict refuses the direct call');
select todo('work package 4 (the PostgREST pre-request) refuses the call: HTTP 401, code XS401, hint session_expired', 3);
select is(pg_temp.read_projects(), 'XS401 session_expired', 'lifetime: reading a project list is refused');
select is(pg_temp.insert_record(), 'XS401 session_expired', 'lifetime: inserting a record is refused');
select is(pg_temp.call_directory(), 'XS401 session_expired', 'lifetime: a definer function that reads memberships inline is refused');

-- An idle session ----------------------------------------------------------------------------------------------------------------
select pg_temp.attack('idle');
select is(pg_temp.private_text('select private.session_direct_refusal()'), 'session_idle', 'idle: the verdict refuses the direct call');
select todo('work package 4 (the PostgREST pre-request) refuses the call: HTTP 401, code XS401, hint session_idle', 3);
select is(pg_temp.read_projects(), 'XS401 session_idle', 'idle: reading a project list is refused');
select is(pg_temp.insert_record(), 'XS401 session_idle', 'idle: inserting a record is refused');
select is(pg_temp.call_directory(), 'XS401 session_idle', 'idle: a definer function that reads memberships inline is refused');

-- An idle session that sends a touch after the timeout ----------------------------------------------------------------------
select pg_temp.attack('idle_touched');
select is(pg_temp.private_text('select private.session_direct_refusal()'), 'session_idle',
  'idle, then a touch: the verdict still refuses the direct call');
select todo('work package 4 (the PostgREST pre-request) refuses the call: HTTP 401, code XS401, hint session_idle', 3);
select is(pg_temp.read_projects(), 'XS401 session_idle', 'idle, then a touch: reading a project list is refused');
select is(pg_temp.insert_record(), 'XS401 session_idle', 'idle, then a touch: inserting a record is refused');
select is(pg_temp.call_directory(), 'XS401 session_idle', 'idle, then a touch: a definer function that reads memberships inline is refused');

-- A session signed out from another device ------------------------------------------------------------------------------------
select pg_temp.attack('ended', 'alice');
select is(pg_temp.private_text('select private.session_direct_refusal()'), 'session_ended', 'signed out: the verdict refuses the direct call');
-- Since 904190901 the gated helpers leave a signed-out session no organization, so the function refuses it at its
-- capability check, before the step-up check (904180204's suite holds that the step-up check refuses it too).
select throws_ok($$select * from app.create_api_key(pg_temp.id('org_a'), 'Attack suite key', array['crew'], now() + interval '30 days')$$, '42501',
  'organization not found',
  'signed out: a step-up function at aal2 refuses the session');
select todo('work package 4 (the PostgREST pre-request) refuses the call: HTTP 401, code XS401, hint session_ended', 3);
select is(pg_temp.read_projects(), 'XS401 session_ended', 'signed out: reading a project list is refused');
select is(pg_temp.insert_record(), 'XS401 session_ended', 'signed out: inserting a record is refused');
select is(pg_temp.call_directory(), 'XS401 session_ended', 'signed out: a definer function that reads memberships inline is refused');

-- Outside the allow-list, with a session token -------------------------------------------------------------------------------
select pg_temp.attack('network');
select is(pg_temp.private_text('select private.session_direct_refusal()'), 'network_restricted', 'network: the verdict refuses the direct call');
select todo('work package 4 (the PostgREST pre-request) refuses the call: HTTP 401, code XS401, hint network_restricted', 3);
select is(pg_temp.read_projects(), 'XS401 network_restricted', 'network: reading a project list is refused');
select is(pg_temp.insert_record(), 'XS401 network_restricted', 'network: inserting a record is refused');
select is(pg_temp.call_directory(), 'XS401 network_restricted', 'network: a definer function that reads memberships inline is refused');

-- Outside the allow-list, with an API-key token ------------------------------------------------------------------------------
select pg_temp.attack('network_key');
select is(pg_temp.private_text('select private.session_direct_refusal()'), 'network_restricted', 'network, API key: the verdict refuses the direct call');
select todo('work package 4 (the PostgREST pre-request) refuses the call: HTTP 401, code XS401, hint network_restricted', 3);
select is(pg_temp.read_projects(), 'XS401 network_restricted', 'network, API key: reading a project list is refused');
select is(pg_temp.insert_record(), 'XS401 network_restricted', 'network, API key: inserting a record is refused');
select is(pg_temp.call_directory(), 'XS401 network_restricted', 'network, API key: a definer function that reads memberships inline is refused');

-- A token with no session_id claim ---------------------------------------------------------------------------------------------
select pg_temp.attack('no_session_id');
select is(pg_temp.private_text('select private.session_direct_refusal()'), 'session_ended', 'no session_id: the verdict refuses the direct call');
select todo('work package 4 (the PostgREST pre-request) refuses the call: HTTP 401, code XS401, hint session_ended', 3);
select is(pg_temp.read_projects(), 'XS401 session_ended', 'no session_id: reading a project list is refused');
select is(pg_temp.insert_record(), 'XS401 session_ended', 'no session_id: inserting a record is refused');
select is(pg_temp.call_directory(), 'XS401 session_ended', 'no session_id: a definer function that reads memberships inline is refused');

-- A lifted attestation, replayed ---------------------------------------------------------------------------------------------
-- The attacker holds a session token and an attestation one of our servers signed for that session inside the
-- allowed network, and presents it again as the signed argument of app.touch_my_session.
select pg_temp.attack('network');
insert into world values ('lifted', pg_temp.private_text('select private.session_id()::text')::uuid);
select app.touch_my_session('Compass', null, null, null,
  pg_temp.attestation(pg_temp.id('bob_user'), pg_temp.id('lifted'), '203.0.113.7', interval '4 minutes 50 seconds'));
select is(pg_temp.private_text('select private.session_direct_refusal()'), null,
  'a replayed attestation: inside five minutes of its signature it still gives the pass');
select pg_temp.as_owner_of_gate(format(
  'update private.session_state set pass_at = pass_at - interval ''11 seconds'', last_activity_at = last_activity_at - interval ''11 seconds''
   where session_id = %L', pg_temp.id('lifted')));
select is(pg_temp.private_text('select private.session_direct_refusal()'), 'network_restricted',
  'a replayed attestation: eleven seconds on, five minutes after the server signed it, the pass is over, whenever it was replayed');

select pg_temp.attack('network');
insert into world values ('moved', pg_temp.private_text('select private.session_id()::text')::uuid);
select app.touch_my_session('Compass', null, null, null,
  pg_temp.attestation(pg_temp.id('bob_user'), pg_temp.id('moved'), '198.51.100.7', interval '10 seconds'));
select is(pg_temp.private_text('select private.session_direct_refusal()'), 'network_restricted',
  'a session our server last saw outside the allowed network is refused');
select app.touch_my_session('Compass', null, null, null,
  pg_temp.attestation(pg_temp.id('bob_user'), pg_temp.id('moved'), '203.0.113.7', interval '3 minutes'));
select is(pg_temp.private_text('select private.session_direct_refusal()'), 'network_restricted',
  'and replaying an older attestation from inside the network does not move its pass back inside');

-- A slow write under observe -------------------------------------------------------------------------------------------------
-- Observe counts each call enforce would refuse in one row for the organization, control, kind of token and reason.
-- A member who keeps a write open must not make every other member's call wait on that row.
select pg_temp.as_platform();
select pg_temp.gate_all('off');
select pg_temp.gate('mfa', 'observe');
select pg_temp.as_session('bob', 'aal1', interval '10 minutes');
select pg_temp.private_text($$select private.session_verdict_store('postgrest')$$);
select pg_temp.as_platform();
select is((select count(*)::int from pg_locks l
           where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 1 and l.granted
             and ((l.classid::bigint << 32) | l.objid::bigint) = private.session_gate_lock_key('observe',
                   concat_ws('|', to_char((now() at time zone 'UTC')::date, 'YYYYMMDD'), 'mfa', 'postgrest', pg_temp.id('org_a'), 'session', 'session_mfa_required'))), 1,
  'observe: the counter of an observed call is written under a lock that is tried and never waited for, so a slow write stalls nobody');

-- A refused session can still read why ----------------------------------------------------------------------------------------
select pg_temp.attack('mfa');
select is(pg_temp.direct('select count(*) from app.my_session_gate()', 'POST', '/rpc/my_session_gate'), 'answered',
  'a session an organization refuses still reaches app.my_session_gate');
select results_eq($$select org_name, closed, reason from app.my_session_gate()$$,
  $$values ('Northwind Live', true, 'session_mfa_required')$$, 'and reads which organization refuses it and why');

select * from finish();
rollback;
