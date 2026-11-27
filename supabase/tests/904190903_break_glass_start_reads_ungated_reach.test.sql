-- pgTAP: migration 904190903, break-glass stays reachable by a session an organization refuses (ADR 0169 D2 and D8,
-- RRR-243). With every control off app.start_break_glass answers as 1203 wrote it. With the allow-list enforced, an
-- Owner outside the listed networks still takes emergency access at aal2, which lifts the allow-list for them; a
-- member without the capability is still refused, and a session the signed-out control refuses is refused with
-- session_ended.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql
\ir 904180200_session_gate_fixture.psql

select plan(14);

create function pg_temp.has_break_glass(p_org text) returns text
language sql as $$
  select pg_temp.private_text(format('select private.has_capability(%L, ''org.break_glass.use'')::text', pg_temp.id(p_org)))
$$;

-- Emergency access is a ledger: the Owner ends her own session through app.end_break_glass.
create function pg_temp.end_break_glass() returns void
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_platform();
  select b.id into v_id from app.break_glass_sessions b where b.person_id = pg_temp.id('alice') and b.ended_at is null;
  perform pg_temp.as_user_stepped_up('alice');
  perform app.end_break_glass(v_id);
  perform pg_temp.as_platform();
end $$;

select pg_temp.as_platform();

-- The catalog.
select ok((select p.prosrc ~ 'private\.person_capability_reach_base\(v_person, p_org_id, ''org\.break_glass\.use'', true\)'
             and p.prosrc !~ 'private\.has_capability\('
             and p.prosrc ~ 'private\.session_ended_refused\(\)'
           from pg_proc p where p.oid = 'app.start_break_glass(uuid, text)'::regprocedure),
  'app.start_break_glass reads the ungated reach and the signed-out refusal');
select ok(has_function_privilege('authenticated', 'app.start_break_glass(uuid, text)', 'execute')
  and has_function_privilege('service_role', 'app.start_break_glass(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'app.start_break_glass(uuid, text)', 'execute'),
  'its grants did not move');
select is((select obj_description('app.start_break_glass(uuid, text)'::regprocedure, 'pg_proc')) is not null, true,
  'and it keeps its comment');
select ok('start_break_glass' = any (private.session_gate_open_functions()), 'it is a function a refused session still reaches');

-- Every control off: as 1203 wrote it.
select pg_temp.allow_network('org_a', 'alice', '203.0.113.0/24');
select pg_temp.as_session('alice', 'aal2', interval '10 minutes');
select lives_ok($$select app.start_break_glass(pg_temp.id('org_a'), 'The office network is down during load-in and payroll must run.')$$,
  'off: the Owner takes emergency access at aal2');
select pg_temp.end_break_glass();
select pg_temp.as_session('mia', 'aal2', interval '10 minutes');
select throws_ok($$select app.start_break_glass(pg_temp.id('org_a'), 'The office network is down during load-in and payroll must run.')$$,
  '42501', 'org.break_glass.use is required', 'off: a member without the capability is refused');
select pg_temp.as_session('alice', 'aal1', interval '10 minutes');
select throws_ok($$select app.start_break_glass(pg_temp.id('org_a'), 'The office network is down during load-in and payroll must run.')$$,
  'XR001', 'step_up_required: Verify with your second factor before taking emergency access.',
  'off: a single-factor session is asked to step up');

-- The allow-list enforced: the Owner outside the list recovers through break-glass.
select pg_temp.as_platform();
select pg_temp.gate('network', 'enforce');
select pg_temp.as_session('alice', 'aal2', interval '10 minutes');
select is(pg_temp.org_reasons('org_a'), 'network_restricted', 'network enforce: an Owner outside the list is refused');
select is(pg_temp.has_break_glass('org_a'), 'false', 'network enforce: the gated reach hides every capability there');
select lives_ok($$select app.start_break_glass(pg_temp.id('org_a'), 'The office network is down during load-in and payroll must run.')$$,
  'network enforce: the Owner still takes emergency access at aal2');
select is(pg_temp.org_reasons('org_a'), null, 'network enforce: and the open break-glass session lifts the allow-list');
select pg_temp.end_break_glass();
select pg_temp.as_session('mia', 'aal2', interval '10 minutes');
select throws_ok($$select app.start_break_glass(pg_temp.id('org_a'), 'The office network is down during load-in and payroll must run.')$$,
  '42501', 'org.break_glass.use is required', 'network enforce: a member without the capability is still refused');

-- The signed-out control enforced: a session with no live row takes nothing.
select pg_temp.as_platform();
select pg_temp.gate_all('off');
select pg_temp.gate('ended', 'enforce');
select pg_temp.as_session('alice', 'aal2', interval '10 minutes', p_row => false);
select throws_ok($$select app.start_break_glass(pg_temp.id('org_a'), 'The office network is down during load-in and payroll must run.')$$,
  'XR001', 'session_ended: This session was signed out. Sign in again to take emergency access.',
  'ended enforce: a signed-out session at aal2 cannot take emergency access');
select pg_temp.as_platform();
select is((select count(*)::int from app.break_glass_sessions where org_id = pg_temp.id('org_a') and ended_at is null), 0,
  'and no break-glass session is open');

select * from finish();
rollback;
