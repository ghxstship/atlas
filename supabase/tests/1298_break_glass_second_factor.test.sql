-- pgTAP: migration 1298, finding A69-009 (RRR-114). An open break-glass session reaches the Owner role's capabilities
-- and lifts the IP allow-list only for the holder, in a second-factor (aal2) session that is not an API key. A
-- password-only session of the same person and a delegate of the holder get nothing extra, and a session that runs
-- its hour is written to the audit ledger as expired, once.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(13);

create function pg_temp.claims_aal(p_key text, p_aal text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

create function pg_temp.as_aal(p_key text, p_aal text) returns void
language plpgsql as $$
begin
  perform pg_temp.claims_aal(p_key, p_aal);
  perform set_config('role', 'authenticated', true);
end $$;

-- Dave, a Member, may use break-glass for the test; Erin holds his approvals by delegation.
select pg_temp.as_platform();
insert into app.user_capability_grants (org_id, membership_id, capability_code, reason)
values (pg_temp.id('org_a'), pg_temp.id('dave@org_a'), 'org.break_glass.use', 'Test: emergency access holder without the Owner role.');
insert into app.delegations (org_id, delegator_membership_id, delegate_membership_id, capability_code, valid_from, valid_to, reason)
values (pg_temp.id('org_a'), pg_temp.id('dave@org_a'), pg_temp.id('erin@org_a'), null, now(), now() + interval '1 day',
  'Test: a delegate of the break-glass holder.');
select pg_temp.as_user('bob');
insert into app.org_ip_allowlist (org_id, cidr, label) values (pg_temp.id('org_a'), '203.0.113.0/24', 'Office');
select app.set_setting(pg_temp.id('org_a'), 'security.ip_allowlist', 'Organization', null, null, true);

select pg_temp.as_aal('dave', 'aal2');
select lives_ok($$select app.start_break_glass((select id from world where key = 'org_a'), 'Locked out by the allow-list on the road to the venue.')$$,
  'the holder takes emergency access with a second factor');

select pg_temp.claims_aal('dave', 'aal2');
select is(private.has_capability(pg_temp.id('org_a'), 'org.security.write'), true,
  'in the second-factor session the Owner role''s capabilities reach org-wide');
select pg_temp.as_aal('dave', 'aal2');
select is((select allowed from app.network_access(pg_temp.id('org_a'), '198.51.100.7')), true,
  'in the second-factor session the allow-list lets the holder in');

select pg_temp.claims_aal('dave', 'aal1');
select is(private.has_capability(pg_temp.id('org_a'), 'org.security.write'), false,
  'a password-only session of the holder gets no emergency reach');
select pg_temp.as_aal('dave', 'aal1');
select is((select allowed from app.network_access(pg_temp.id('org_a'), '198.51.100.7')), false,
  'a password-only session of the holder stays outside the allow-list');

select pg_temp.as_platform();
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('dave_user'), 'role', 'authenticated', 'aal', 'aal2',
  'scopes', json_build_array('org'), 'amr', json_build_array(json_build_object('method', 'xos_api_key', 'timestamp', 0)))::text, true);
select is(private.has_capability(pg_temp.id('org_a'), 'org.security.write'), false,
  'an API-key token for the holder gets no emergency reach, even in scope');

select pg_temp.claims_aal('dave', 'aal2');
select is(private.has_capability(pg_temp.id('org_a'), 'finance.budget.approve'), true,
  'the holder''s emergency reach includes approvals only Owners hold');
select pg_temp.claims_aal('erin', 'aal2');
select is(private.has_capability(pg_temp.id('org_a'), 'finance.budget.approve'), false,
  'a delegate of the holder''s approvals does not inherit the emergency reach');

select pg_temp.as_platform();
select is(private.person_capability_reach(pg_temp.id('dave'), pg_temp.id('org_a'), 'org.security.write', false), null,
  'asked about the holder from outside his session, the reach has no emergency branch');

-- A session that ran its hour.
select pg_temp.as_platform();
update app.break_glass_sessions set deleted_at = now() where person_id = pg_temp.id('dave');
insert into app.break_glass_sessions (org_id, person_id, reason, started_at, expires_at)
values (pg_temp.id('org_a'), pg_temp.id('alice'), 'Ran its whole hour during the load-in emergency.', now() - interval '2 hours',
  now() - interval '1 hour');
insert into world select 'bg_old', id from app.break_glass_sessions where person_id = pg_temp.id('alice');
select is(private.audit_expired_break_glass(), 1, 'the expired session is written to the ledger');
select is((select count(*)::int from app.audit_events where action = 'break_glass_sessions.expired' and subject_id = pg_temp.id('bg_old')),
  1, 'as break_glass_sessions.expired');
select is(private.audit_expired_break_glass(), 0, 'once');
select ok(exists (select 1 from cron.job where jobname = 'xos_audit_expired_break_glass' and schedule = '*/5 * * * *'),
  'the expiry audit runs every five minutes');

select * from finish();
rollback;
