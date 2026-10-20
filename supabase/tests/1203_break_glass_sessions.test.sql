-- pgTAP: migration 1203, break-glass sessions (A52, ADR 0032 amendment). Only a holder of org.break_glass.use (the Owner)
-- takes emergency access, and only after a second factor, with a written reason, never with an API key and never twice at
-- once. The session lasts one hour, notifies every other Owner and Admin, is in the audit ledger, gives the Owner role's
-- capabilities org-wide and lets the holder past the IP allow-list; ending it takes all of that away. Sessions are a ledger.
-- Cross-tenant and anon denied.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(24);

create function pg_temp.as_stepped_up(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

select has_table('app', 'break_glass_sessions', 'app.break_glass_sessions exists');

-- Refusals.
select pg_temp.as_stepped_up('bob');
select throws_ok($$select app.start_break_glass((select id from world where key = 'org_a'), 'Payroll export failed during show day and must run now.')$$,
  '42501', null, 'an Admin cannot take emergency access');
select pg_temp.as_user('alice');
select throws_ok($$select app.start_break_glass((select id from world where key = 'org_a'), 'Payroll export failed during show day and must run now.')$$,
  'XR001', 'step_up_required: Verify with your second factor before taking emergency access.', 'the Owner needs a second factor first');
select pg_temp.as_stepped_up('alice');
select throws_ok($$select app.start_break_glass((select id from world where key = 'org_a'), 'Because.')$$,
  'XR001', 'break_glass_reason: Write why you need emergency access, in at least 20 characters.', 'a written reason is required');
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('alice_user'), 'role', 'authenticated', 'aal', 'aal2',
  'scopes', json_build_array('org'), 'amr', json_build_array(json_build_object('method', 'xos_api_key', 'timestamp', 0)))::text, true);
select throws_ok($$select app.start_break_glass((select id from world where key = 'org_a'), 'Payroll export failed during show day and must run now.')$$,
  'XR001', null, 'never with an API key');

-- The Owner takes it.
select pg_temp.as_stepped_up('alice');
select lives_ok($$select app.start_break_glass((select id from world where key = 'org_a'), 'Payroll export failed during show day and must run now.')$$,
  'the Owner takes emergency access with a second factor and a reason');
insert into world select 'bg1', id from app.break_glass_sessions where person_id = pg_temp.id('alice');
select is((select expires_at - started_at from app.break_glass_sessions where id = pg_temp.id('bg1')), interval '1 hour', 'it lasts one hour');
select throws_ok($$select app.start_break_glass((select id from world where key = 'org_a'), 'A second emergency while the first is open.')$$,
  'XR001', 'break_glass_open: You already hold emergency access in this org.', 'one open session at a time');
select throws_ok($$update app.break_glass_sessions set expires_at = expires_at + interval '1 day' where id = (select id from world where key = 'bg1')$$,
  '42501', null, 'the session cannot be extended');
select throws_ok($$insert into app.break_glass_sessions (org_id, person_id, reason, expires_at) values ((select id from world where key = 'org_a'), (select id from world where key = 'alice'), 'Inserted directly to skip the checks.', now() + interval '1 hour')$$,
  '42501', null, 'nor written directly');

select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where kind = 'access.break_glass_started' and subject_id = pg_temp.id('bg1')
  and recipient_person_id = pg_temp.id('bob')), 1, 'the Admin is notified');
select is((select count(*)::int from app.notifications where kind = 'access.break_glass_started' and subject_id = pg_temp.id('bg1')
  and recipient_person_id = pg_temp.id('alice')), 0, 'the holder is not notified of their own session');
select is((select count(*)::int from app.audit_events where action = 'break_glass_sessions.started' and subject_id = pg_temp.id('bg1')), 1,
  'the start is in the audit ledger');

select pg_temp.as_user('bob');
select is((select reason from app.break_glass_sessions where id = pg_temp.id('bg1')), 'Payroll export failed during show day and must run now.',
  'Admins with the audit log read the session and its reason');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.break_glass_sessions), 0, 'a Manager reads no sessions');

-- Enforcement: emergency full access and the IP allow-list. Dave, a Member, is granted org.break_glass.use for the test.
select pg_temp.as_platform();
insert into app.user_capability_grants (org_id, membership_id, capability_code, reason)
values (pg_temp.id('org_a'), pg_temp.id('dave@org_a'), 'org.break_glass.use', 'Test: emergency access holder without the Owner role.');
select pg_temp.as_user('bob');
insert into app.org_ip_allowlist (org_id, cidr, label) values (pg_temp.id('org_a'), '203.0.113.0/24', 'Office');
select app.set_setting(pg_temp.id('org_a'), 'security.ip_allowlist', 'Organization', null, null, true);

select pg_temp.claims('dave');
select is(private.has_capability(pg_temp.id('org_a'), 'org.security.write'), false, 'before: a Member cannot edit security');
select pg_temp.as_user('dave');
select is((select allowed from app.network_access(pg_temp.id('org_a'), '198.51.100.7')), false, 'before: the allow-list refuses his address');
select pg_temp.as_stepped_up('dave');
select lives_ok($$select app.start_break_glass((select id from world where key = 'org_a'), 'Locked out by the allow-list on the road to the venue.')$$,
  'he takes emergency access');
insert into world select 'bg2', id from app.break_glass_sessions where person_id = pg_temp.id('dave');
-- 1298 (A69-009): the emergency reach applies in the holder's second-factor session only.
select pg_temp.as_stepped_up('dave');
select set_config('role', 'postgres', true);
select is(private.has_capability(pg_temp.id('org_a'), 'org.security.write'), true, 'during: the Owner role''s capabilities reach org-wide');
select pg_temp.as_stepped_up('dave');
select is((select allowed from app.network_access(pg_temp.id('org_a'), '198.51.100.7')), true, 'during: the allow-list lets the holder in');
select lives_ok($$select app.end_break_glass((select id from world where key = 'bg2'))$$, 'he ends it early');
select set_config('role', 'postgres', true);
select is(private.has_capability(pg_temp.id('org_a'), 'org.security.write'), false, 'after: the extra reach is gone');

select pg_temp.as_user('xavier');
select is((select count(*)::int from app.break_glass_sessions), 0, 'cross-tenant: another org reads no sessions');

select pg_temp.as_anon();
select throws_ok('select 1 from app.break_glass_sessions', '42501', null, 'anon reads no sessions');

select * from finish();
rollback;
