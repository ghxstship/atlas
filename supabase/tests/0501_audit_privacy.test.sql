-- pgTAP: audit ledger, activity feed, consent, privacy signals, data subject requests and the file
-- access log (Section 7.3, Section 8.4, Section 14.3, Section 14.5): same-tenant allow, cross-tenant
-- deny, anon deny and role boundaries, plus the 30-day clock and public rate limits.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(52);

-- Audit trail -----------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into app.membership_roles (membership_id, role_id) values (pg_temp.id('gina@org_a'), pg_temp.system_role('member'));
select pg_temp.as_platform();
select is(
  (select count(*)::integer from app.audit_events where action = 'membership_roles.insert' and org_id = pg_temp.id('org_a')
     and actor_person_id = pg_temp.id('bob') and diff -> 'new' ->> 'membership_id' = pg_temp.id('gina@org_a')::text),
  1, 'a role grant is written to the audit ledger with its actor and diff');
select ok(
  (select bool_and(not (diff -> 'new' ? 'token_hash')) from app.audit_events where action = 'invites.insert'),
  'audit diffs never carry token hashes');
select ok(
  (select bool_and(actor_kind = 'Person') from app.audit_events where action = 'membership_roles.insert' and org_id = pg_temp.id('org_a')),
  'person actions are recorded as Person');
select pg_temp.as_user('alice');
select ok((select count(*) from app.audit_events where org_id = pg_temp.id('org_a')) > 0, 'an owner reads the audit log');
select is((select count(*)::integer from app.audit_events where org_id = pg_temp.id('org_b')), 0, 'no cross-tenant audit reads');
select throws_ok($$insert into app.audit_events (org_id, actor_kind, action, subject_table) values (pg_temp.id('org_a'), 'System', 'forged.event', 'app.teams')$$,
  '42501', null, 'nobody writes audit events directly');
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.audit_events), 0, 'a manager cannot read the audit log');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.audit_events where org_id = pg_temp.id('org_a')), 0, 'another org reads none of the ledger');
select pg_temp.as_platform();

-- Activity feed --------------------------------------------------------------------------------------------
select ok((select count(*) from app.activity_events a join app.domain_events e on e.id = a.domain_event_id
           where e.event_type = 'project.created' and e.subject_id = pg_temp.id('prj_a')) = 1,
  'every domain event lands in the activity feed');
select is((select actor_person_id from app.activity_events a join app.domain_events e on e.id = a.domain_event_id
           where e.event_type = 'project.created' and e.subject_id = pg_temp.id('prj_a')), pg_temp.id('alice'),
  'the activity records who raised the event');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.activity_events a join app.domain_events e on e.id = a.domain_event_id where e.subject_id = pg_temp.id('prj_a') and e.event_type = 'project.created'), 0,
  'the event row itself stays behind its own policy');
select ok((select count(*) from app.activity_events) > 0, 'a project member reads activity of their project');
select ok(not exists (select 1 from app.activity_events where org_id <> pg_temp.id('org_a')),
  'a member reads activity only of their own org');
select pg_temp.as_user('xavier');
select ok((select count(*) from app.activity_events where org_id = pg_temp.id('org_a')) = 0, 'no cross-tenant activity');
select pg_temp.as_platform();
select is(
  (select count(*)::integer from app.activity_events a join app.domain_events e on e.id = a.domain_event_id where e.project_id = pg_temp.id('prj_a2')),
  (select count(*)::integer from app.domain_events where project_id = pg_temp.id('prj_a2')), 'prj_a2 has activity rows');
select pg_temp.as_user('dave');
select is(
  (select count(*)::integer from app.activity_events where org_id = pg_temp.id('org_a')
     and domain_event_id in (select id from app.domain_events where project_id = pg_temp.id('prj_a2'))), 0,
  'a member does not read activity of a project they are not on (invariant 2)');
select pg_temp.as_platform();
select throws_ok($$update app.activity_events set actor_person_id = null$$, 'XR001', null, 'the activity feed is append-only');

-- Consent records -----------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
  values (pg_temp.id('org_a'), pg_temp.id('dave'), 'marketing_email', '2026-10', 'Web')$$, 'a person records their own consent');
select throws_ok($$insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
  values (pg_temp.id('org_a'), pg_temp.id('bob'), 'marketing_email', '2026-10', 'Web')$$, '42501', null,
  'nobody records consent for someone else');
select throws_ok($$insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
  values (pg_temp.id('org_a'), pg_temp.id('dave'), 'marketing_email', '2026-11', 'Web')$$, '23505', null,
  'one standing consent per purpose');
select throws_ok($$update app.consent_records set notice_version = '2027-01' where person_id = pg_temp.id('dave')$$, 'XR001', null,
  'consent evidence is immutable');
select lives_ok($$update app.consent_records set withdrawn_at = now() where person_id = pg_temp.id('dave')$$, 'a person withdraws consent');
select throws_ok($$update app.consent_records set withdrawn_at = now() - interval '1 day' where person_id = pg_temp.id('dave')$$, 'XR001', null,
  'a withdrawal is recorded once');
select pg_temp.as_user('bob');
select is((select count(*)::integer from app.consent_records where org_id = pg_temp.id('org_a')), 1, 'an admin reads the org''s consent records');
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.consent_records), 0, 'a manager reads no one else''s consents');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.consent_records), 0, 'no cross-tenant consent reads');

-- Cookie banner and Global Privacy Control --------------------------------------------------------------------------
select pg_temp.as_anon();
select is(api_public.record_cookie_consent('visitor-0123456789abcdef', 'northwind-live', true, false, true, 'banner-3', true), true,
  'an anonymous visitor records a cookie decision');
select pg_temp.as_platform();
select is((select marketing from app.cookie_consent_events where org_id = pg_temp.id('org_a')), false,
  'Global Privacy Control refuses marketing cookies');
select is((select count(*)::integer from app.privacy_signals where signal = 'Global Privacy Control' and org_id = pg_temp.id('org_a')), 1,
  'the GPC signal is recorded server-side');
select is((select count(*)::integer from app.cookie_consent_events where visitor_hash = extensions.digest('visitor-0123456789abcdef', 'sha256')), 1,
  'only a hash of the visitor id is stored');
select pg_temp.as_anon();
select is(api_public.record_cookie_consent('short', null, true, true, true, 'banner-3'), false, 'a malformed visitor id is refused');
select throws_ok($$select 1 from app.cookie_consent_events$$, '42501', null, 'anon cannot read the consent log');
select pg_temp.as_platform();
select private.note_rate_event('cookie_consent', 'unknown') from generate_series(1, 30);
select pg_temp.as_anon();
select is(api_public.record_cookie_consent('visitor-fedcba9876543210', null, true, true, true, 'banner-3'), false,
  'the public consent RPC is rate-limited per client');
select pg_temp.as_user('bob');
select is((select count(*)::integer from app.privacy_signals), 1, 'an admin reads the org''s privacy signals');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.privacy_signals), 0, 'no cross-tenant privacy signal reads');

-- SMS consent ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into app.sms_consent_events (org_id, person_id, phone_e164, action, source) values
  (pg_temp.id('org_a'), pg_temp.id('frank'), '+13055550147', 'Opt In', 'Mobile');
select is((select may_text from app.sms_consent_status where phone_e164 = '+13055550147'), true, 'an opt-in lets the org text the number');
select pg_temp.as_platform();
insert into app.sms_consent_events (org_id, person_id, phone_e164, action, keyword, source) values
  (pg_temp.id('org_a'), pg_temp.id('frank'), '+13055550147', 'Opt Out', 'STOP', 'SMS');
select is((select may_text from app.sms_consent_status where phone_e164 = '+13055550147'), false, 'STOP ends consent');
select throws_ok($$update app.sms_consent_events set action = 'Opt In'$$, 'XR001', null, 'the SMS consent ledger is append-only');
select pg_temp.as_user('frank');
select throws_ok($$insert into app.sms_consent_events (org_id, person_id, phone_e164, action, source)
  values (pg_temp.id('org_b'), pg_temp.id('frank'), '+13055550147', 'Opt In', 'Web')$$, '42501', null,
  'nobody records SMS consent for an org they do not belong to');

-- Data subject requests ----------------------------------------------------------------------------------------------
select pg_temp.as_user('nina');
select ok(app.submit_dsar(pg_temp.id('org_a'), 'Access', 'Send me everything you hold about me.') is not null,
  'any signed-in person can submit a request to an org');
select is((select subject_email from app.dsar_requests), 'nina@nowhere.test', 'the subject is the signed-in caller');
select is((select due_at - received_at from app.dsar_request_clock), interval '30 days', 'the clock runs 30 days from receipt');
select throws_ok($$select app.transition_dsar((select id from app.dsar_requests), 'Received', 'In Progress', 'Self-serve.')$$, '42501', null,
  'the requester cannot move their own request');
select pg_temp.as_user('alice');
select ok(app.transition_dsar((select id from app.dsar_requests), 'Received', 'In Progress', 'Identity verified by sign-in.') is not null,
  'an owner moves the request');
select ok(app.transition_dsar((select id from app.dsar_requests), 'In Progress', 'Extended', 'Records span three projects.') is not null,
  'a request can be extended with a reason');
select is((select due_at - received_at from app.dsar_request_clock), interval '90 days', 'an extension adds 60 days to the clock');
select throws_ok($$select app.transition_dsar((select id from app.dsar_requests), 'Extended', 'Received', 'Back.')$$, 'XR001', null,
  'a request cannot move backwards');
select throws_ok($$update app.dsar_requests set dsar_state = 'Completed'$$, 'XR001', null, 'state changes only through the transition RPC');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.dsar_requests), 0, 'another org cannot see the request');
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.dsar_request_clock), 0, 'a manager cannot see the request');

-- File access log -------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.file_access_log (org_id, person_id, bucket_id, object_path, action, classification)
values (pg_temp.id('org_a'), pg_temp.id('dave'), 'documents', 'org_a/contract.pdf', 'Download', 'Confidential');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.file_access_log), 1, 'a person reads their own file access');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.file_access_log), 0, 'no cross-tenant file access reads');

select * from finish();
rollback;
