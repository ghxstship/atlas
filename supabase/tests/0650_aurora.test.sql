-- pgTAP: Aurora AI (Section 4.7, ADR 0020). Settings switches with the Admin band boundary and the plan gate, request
-- authorization and metering against the monthly allowance, redacted request logs, suggestions pending confirmation
-- with their lifecycle, per-field confidence and NO_ANSWER, and what is never sent to a model.
-- World: org_a Northwind Live (Team), org_b Harbor Lights (Access), org_c Tidewater Events (Core).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select * from no_plan();

-- Never sent -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select ok(exists (select 1 from app.ai_never_send where table_name = 'app.medical_encounters' and column_name is null),
  'medical encounters are excluded whole');
select ok(exists (select 1 from app.ai_never_send where table_name = 'app.pay_rates' and column_name = 'rate_minor'),
  'Restricted pay rates are never sent');
select ok(exists (select 1 from app.ai_never_send where table_name = 'app.vendor_bank_accounts' and column_name = 'account_number'),
  'Restricted bank details are never sent');
select pg_temp.as_anon();
select throws_ok('select count(*) from app.ai_never_send', '42501', null, 'anon cannot read the never-send list');

-- Redaction --------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(private.ai_redact('Call Ivy at (305) 555-0142 or ivy@example.com.'), 'Call Ivy at [phone] or [email].',
  'phone numbers and email addresses are redacted');
select is(private.ai_redact('SSN 123-45-6789, card 4242 4242 4242 4242'), 'SSN [government id], card [card number]',
  'government identifiers and card numbers are redacted');
select is(private.ai_redact('Load-in at 14:00 on 2026-11-03 for 120 crew.'), 'Load-in at 14:00 on 2026-11-03 for 120 crew.',
  'times, dates and quantities pass untouched');

-- Settings ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::int from app.ai_settings), 0, 'no settings row yet');
select is((select count(*)::int from app.ai_enabled_features(pg_temp.id('org_a'))), 0, 'an org without a row has every feature off');
select throws_ok($$insert into app.ai_settings (org_id, assistant_enabled) values ((select id from world where key = 'org_a'), true)$$,
  '42501', null, 'a Member cannot turn features on');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.ai_settings (org_id, assistant_enabled) values ((select id from world where key = 'org_a'), true)$$,
  '42501', null, 'a Manager (band 3) cannot turn features on');
select pg_temp.as_user('bob');
select lives_ok($$insert into app.ai_settings (org_id, assistant_enabled, extraction_enabled) values ((select id from world where key = 'org_a'), true, true)$$,
  'an Admin (band 2) turns features on');
select is((select count(*)::int from app.domain_events where event_type = 'ai_settings.changed' and org_id = pg_temp.id('org_a')), 1,
  'turning features on emits ai_settings.changed');
select pg_temp.as_user('dave');
select is((select assistant_enabled from app.ai_settings where org_id = pg_temp.id('org_a')), true, 'a same-org Member reads the switches');
select results_eq($$select f::text from app.ai_enabled_features((select id from world where key = 'org_a')) f order by 1$$,
  array['assistant', 'extraction'], 'members see exactly the features turned on');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.ai_settings), 0, 'another org reads no switches');
select is((select count(*)::int from app.ai_enabled_features(pg_temp.id('org_a'))), 0, 'a non-member sees no enabled features');
select throws_ok($$insert into app.ai_settings (org_id, assistant_enabled) values ((select id from world where key = 'org_b'), true)$$,
  'XR001', 'aurora_not_in_plan: Aurora AI is not in this org''s plan. Upgrade to Core or above to turn features on.',
  'Access has no aurora_ai: features cannot be turned on');
select lives_ok($$insert into app.ai_settings (org_id) values ((select id from world where key = 'org_b'))$$,
  'an Access org may keep every feature off');
select is_empty($$update app.ai_settings set assistant_enabled = false where org_id = (select id from world where key = 'org_a') returning id$$,
  'another org changes no switches');
select pg_temp.as_platform();
select is((select assistant_enabled from app.ai_settings where org_id = pg_temp.id('org_a')), true, 'the switch survived the cross-org attempt');
select pg_temp.as_anon();
select throws_ok('select count(*) from app.ai_settings', '42501', null, 'anon cannot read settings');

-- Requests: authorization and metering ---------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.ai_begin_request((select id from world where key = 'org_a'), 'drafting', 'claude-sonnet-5-5')$$,
  'XR001', 'aurora_feature_off: An Admin has not turned on drafting in Settings, AI Features.', 'a feature that is off is refused');
select lives_ok($$insert into world select 'req_dave', app.ai_begin_request((select id from world where key = 'org_a'), 'assistant', 'claude-sonnet-5-5')$$,
  'a Member starts an assistant request');
select is((select outcome::text from app.ai_requests where id = pg_temp.id('req_dave')), 'Pending', 'the request starts Pending');
select is((select person_id from app.ai_requests where id = pg_temp.id('req_dave')), pg_temp.id('dave'), 'the requester is the session person');
select is((select count(*)::int from app.ai_usage where request_id = pg_temp.id('req_dave')), 1, 'the requester reads its usage row');
select is((select used from app.ai_allowance(pg_temp.id('org_a'))), 1::bigint, 'one request used this month');
select is((select allowance from app.ai_allowance(pg_temp.id('org_a'))), 10000::bigint, 'Team allows 10,000 requests a month');
select throws_ok($$select app.ai_begin_request((select id from world where key = 'org_a'), 'assistant', 'Claude Sonnet')$$,
  '23514', null, 'the model identifier must be a configuration id');
select throws_ok($$insert into app.ai_requests (org_id, person_id, feature, model) values ((select id from world where key = 'org_a'), (select id from world where key = 'dave'), 'assistant', 'claude-haiku-5-5')$$,
  '42501', null, 'requests are written only through the RPC');
select pg_temp.as_user('xavier');
select throws_ok($$select app.ai_begin_request((select id from world where key = 'org_a'), 'assistant', 'claude-sonnet-5-5')$$,
  '42501', null, 'a non-member cannot spend another org''s allowance');
select throws_ok($$select app.ai_begin_request((select id from world where key = 'org_b'), 'assistant', 'claude-sonnet-5-5')$$,
  'XR001', 'aurora_not_in_plan: Aurora AI is not in this org''s plan. Upgrade to Core or above to use it.', 'Access is refused before any switch');
select is((select allowance from app.ai_allowance(pg_temp.id('org_b'))), 0::bigint, 'Access has an allowance of 0');
select pg_temp.as_anon();
select throws_ok($$select app.ai_begin_request((select id from world where key = 'org_a'), 'assistant', 'claude-sonnet-5-5')$$,
  '42501', null, 'anon cannot start a request');

-- The Core allowance of 500 runs out
select pg_temp.as_user('cora');
insert into app.ai_settings (org_id, summaries_enabled) values (pg_temp.id('org_c'), true);
select pg_temp.as_platform();
with r as (
  insert into app.ai_requests (org_id, person_id, feature, model, outcome, completed_at)
  select pg_temp.id('org_c'), pg_temp.id('cora'), 'summaries', 'claude-haiku-5-5', 'Answered', now() from generate_series(1, 499)
  returning id)
insert into app.ai_usage (request_id) select id from r;
select pg_temp.as_user('cora');
select lives_ok($$select app.ai_begin_request((select id from world where key = 'org_c'), 'summaries', 'claude-haiku-5-5')$$,
  'the 500th request of the month passes');
select throws_ok($$select app.ai_begin_request((select id from world where key = 'org_c'), 'summaries', 'claude-haiku-5-5')$$,
  'XR001', 'plan_limit_exceeded: The plan allows 500 aurora_requests_per_month; this change needs 501.', 'the 501st is refused');
select pg_temp.as_platform();
update app.ai_usage set metered_at = date_trunc('month', now()) - interval '1 day' where org_id = pg_temp.id('org_c');
select pg_temp.as_user('cora');
select lives_ok($$select app.ai_begin_request((select id from world where key = 'org_c'), 'summaries', 'claude-haiku-5-5')$$,
  'last month''s requests do not count against this month');

-- Completing requests
select pg_temp.as_user('erin');
select throws_ok($$select app.ai_complete_request((select id from world where key = 'req_dave'), 'Answered', 'q', 'a')$$,
  '42501', null, 'only the requester completes a request');
select pg_temp.as_user('dave');
select throws_ok($$select app.ai_complete_request((select id from world where key = 'req_dave'), 'Pending', 'q', 'a')$$,
  'XR001', 'ai_request_outcome_required: A finished request is Answered, No Answer or Failed.', 'a request cannot finish as Pending');
select throws_ok($$select app.ai_complete_request((select id from world where key = 'req_dave'), 'Failed', 'q', null)$$,
  '23514', null, 'a failure names its code');
select lives_ok($$select app.ai_complete_request((select id from world where key = 'req_dave'), 'Answered',
  'Who is the vendor contact? Reach me at dave@northwind.test', 'Ivy Chen, (305) 555-0142.', 812, 96)$$,
  'the requester completes the request');
select is((select prompt_redacted from app.ai_requests where id = pg_temp.id('req_dave')), 'Who is the vendor contact? Reach me at [email]',
  'the stored prompt is redacted by the database');
select is((select output_redacted from app.ai_requests where id = pg_temp.id('req_dave')), 'Ivy Chen, [phone].', 'the stored output is redacted');
select is((select input_tokens from app.ai_usage where request_id = pg_temp.id('req_dave')), 812, 'token counts are metered');
select throws_ok($$select app.ai_complete_request((select id from world where key = 'req_dave'), 'Answered', 'q', 'a')$$,
  'XR001', 'ai_request_already_complete: This request has already finished.', 'a request finishes once');
select throws_ok($$update app.ai_requests set output_redacted = 'edited' where id = (select id from world where key = 'req_dave')$$,
  '42501', null, 'request logs are not editable');

-- Who reads request logs
select pg_temp.as_user('erin');
select is((select count(*)::int from app.ai_requests), 0, 'a colleague does not read another person''s requests');
select is((select count(*)::int from app.ai_usage), 0, 'nor their usage');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.ai_requests), 0, 'a Manager without audit.log.read reads none');
select pg_temp.as_user('bob');
select is((select count(*)::int from app.ai_requests where org_id = pg_temp.id('org_a')), 1, 'an Admin with audit.log.read reads the org''s request log');
select is((select count(*)::int from app.ai_usage where org_id = pg_temp.id('org_a')), 1, 'an Admin with org.usage.read reads usage');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.ai_requests), 0, 'another org reads no requests');
select is((select count(*)::int from app.ai_usage), 0, 'another org reads no usage');
select pg_temp.as_anon();
select throws_ok('select count(*) from app.ai_requests', '42501', null, 'anon cannot read requests');
select throws_ok('select count(*) from app.ai_usage', '42501', null, 'anon cannot read usage');

-- Suggestions ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into world select 'req_pending', app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5', 'app.organizations', pg_temp.id('org_a'));
select throws_ok($$select app.ai_propose_suggestion((select id from world where key = 'req_pending'), 'records.create', null, 'Create a record.', '[]')$$,
  'XR001', 'ai_suggestion_needs_answer: Only an answered request can propose a change.', 'a pending request proposes nothing');
select app.ai_complete_request(pg_temp.id('req_pending'), 'Answered', 'Extract the certificate.', '{}', 2000, 300);
select throws_ok($$select app.ai_propose_suggestion((select id from world where key = 'req_pending'), 'records.create', null, 'Create a record.',
  '[{"field_path": "insurer", "value": "Atlantic Mutual", "refusal": "NO_ANSWER", "missing": "x"}]')$$,
  '23514', null, 'a field carries a value or NO_ANSWER, never both');
select throws_ok($$select app.ai_propose_suggestion((select id from world where key = 'req_pending'), 'records.create', null, 'Create a record.',
  '[{"field_path": "insurer", "value": "Atlantic Mutual", "confidence": 1.4}]')$$,
  '23514', null, 'confidence runs from 0 to 1');
select throws_ok($$select app.ai_propose_suggestion((select id from world where key = 'req_pending'), 'records.create', null, 'Create a record.',
  '[{"field_path": "limit_minor", "refusal": "NO_ANSWER"}]')$$,
  '23514', null, 'NO_ANSWER says what is missing');
select throws_ok($$select app.ai_propose_suggestion((select id from world where key = 'req_pending'), 'Create Record', null, 'Create a record.', '[]')$$,
  '23514', null, 'the operation is a public API operation id');
select lives_ok($$insert into world select 'sug_a', app.ai_propose_suggestion((select id from world where key = 'req_pending'), 'vendorInsurance.create', null,
  'Add the Atlantic Mutual general liability certificate, expiring 2027-03-31.',
  '[{"field_path": "insurer", "value": "Atlantic Mutual", "confidence": 0.97, "source_excerpt": "Insurer A: Atlantic Mutual"},
    {"field_path": "expires_on", "value": "2027-03-31", "confidence": 0.91},
    {"field_path": "limit_minor", "refusal": "NO_ANSWER", "missing": "The certificate does not state a per-occurrence limit."}]')$$,
  'an answered request proposes a change with per-field confidence');
select results_eq($$select field_path, confidence, refusal from app.ai_suggestion_fields where suggestion_id = (select id from world where key = 'sug_a') order by position$$,
  $$values ('insurer'::text, 0.970::numeric(4,3), null::text), ('expires_on', 0.910, null), ('limit_minor', null, 'NO_ANSWER')$$,
  'fields keep their order, confidence and NO_ANSWER');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('sug_a')), 'Proposed', 'a suggestion starts Proposed');
select is((select count(*)::int from app.ai_suggestion_state_transitions where suggestion_id = pg_temp.id('sug_a')), 1, 'creation is logged');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'ai_suggestion.proposed'), 1, 'proposing emits ai_suggestion.proposed');
select pg_temp.as_user('dave');
select throws_ok($$update app.ai_suggestions set suggestion_state = 'Confirmed' where id = (select id from world where key = 'sug_a')$$,
  '42501', null, 'state changes only through the transition RPC');
select throws_ok($$insert into app.ai_suggestions (request_id, operation_id, summary) values ((select id from world where key = 'req_pending'), 'records.create', 'x')$$,
  '42501', null, 'suggestions are written only through the RPC');

select pg_temp.as_user('erin');
select is((select count(*)::int from app.ai_suggestions), 0, 'a colleague does not read another person''s suggestions');
select is((select count(*)::int from app.ai_suggestion_fields), 0, 'nor their fields');
select throws_ok($$select app.ai_propose_suggestion((select id from world where key = 'req_pending'), 'records.create', null, 'x', '[]')$$,
  '42501', null, 'only the requester receives suggestions');
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_a'), 'Proposed', 'Confirmed', 'Looks right.')$$,
  '42501', null, 'only the requester confirms');
select pg_temp.as_user('bob');
select is((select count(*)::int from app.ai_suggestions), 1, 'an Admin with audit.log.read reads suggestions');
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_a'), 'Proposed', 'Confirmed', 'Approving for Dave.')$$,
  '42501', null, 'not even an Admin confirms on the requester''s behalf');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.ai_suggestions), 0, 'another org reads no suggestions');
select is((select count(*)::int from app.ai_suggestion_state_transitions), 0, 'nor their ledger');
select pg_temp.as_anon();
select throws_ok('select count(*) from app.ai_suggestions', '42501', null, 'anon cannot read suggestions');
select throws_ok('select count(*) from app.ai_suggestion_fields', '42501', null, 'anon cannot read suggestion fields');

-- Lifecycle
select pg_temp.as_user('dave');
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_a'), 'Proposed', 'Applied', 'Skip review.', (select id from world where key = 'org_a'))$$,
  'XR001', 'ai_suggestion_transition_not_allowed: A ai suggestion cannot move from Proposed to Applied.', 'nothing is applied without confirmation');
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_a'), 'Proposed', 'Expired', 'Too old.')$$,
  'XR001', 'ai_suggestion_expiry_system: Suggestions expire on their own; reject it instead.', 'people do not expire suggestions');
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_a'), 'Proposed', 'Confirmed', '')$$,
  'XR001', 'transition_reason_required: Every state change carries a reason.', 'every move carries a reason');
select lives_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_a'), 'Proposed', 'Confirmed', 'Checked against the certificate.')$$,
  'the requester confirms');
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_a'), 'Proposed', 'Confirmed', 'Again.')$$,
  'XR001', 'ai_suggestion_state_conflict: The ai suggestion is not in the expected state Proposed.', 'compare-and-set refuses a stale state');
select lives_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_a'), 'Confirmed', 'Proposed', 'The API refused: vendor_blocked.')$$,
  'a refused write returns the suggestion to Proposed');
select lives_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_a'), 'Proposed', 'Confirmed', 'Vendor reinstated.')$$,
  'confirmed again');
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_a'), 'Confirmed', 'Applied', 'Written.')$$,
  'XR001', 'ai_suggestion_applied_id: An applied suggestion names the record the API wrote, and only then.', 'Applied names the written record');
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_a'), 'Confirmed', 'Rejected', 'Changed my mind.')$$,
  'XR001', 'ai_suggestion_transition_not_allowed: A ai suggestion cannot move from Confirmed to Rejected.', 'a confirmed suggestion is not rejected');
select lives_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_a'), 'Confirmed', 'Applied', 'Written by vendorInsurance.create.', (select id from world where key = 'ws_a'))$$,
  'the suggestion is Applied with the written record');
select is((select applied_id from app.ai_suggestions where id = pg_temp.id('sug_a')), pg_temp.id('ws_a'), 'the written record is linked');
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_a'), 'Applied', 'Proposed', 'Undo.')$$,
  'XR001', 'ai_suggestion_transition_not_allowed: A ai suggestion cannot move from Applied to Proposed.', 'Applied is final');
select is((select count(*)::int from app.ai_suggestion_state_transitions where suggestion_id = pg_temp.id('sug_a')), 5, 'every move is in the ledger');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type in ('ai_suggestion.confirmed', 'ai_suggestion.applied')), 3,
  'confirmations and the application emit events');
select pg_temp.as_user('dave');
select throws_ok($$update app.ai_suggestion_state_transitions set reason = 'edited' where suggestion_id = (select id from world where key = 'sug_a')$$,
  '42501', null, 'the ledger is append-only');

-- Rejection and expiry
insert into world select 'sug_b', app.ai_propose_suggestion(pg_temp.id('req_pending'), 'records.update', pg_temp.id('org_a'), 'Retitle the record.', '[{"field_path": "title", "value": "Hang Truss", "confidence": 0.8}]');
insert into world select 'sug_c', app.ai_propose_suggestion(pg_temp.id('req_pending'), 'records.update', pg_temp.id('org_a'), 'Retitle the record.', '[]');
insert into world select 'sug_d', app.ai_propose_suggestion(pg_temp.id('req_pending'), 'records.update', pg_temp.id('org_a'), 'Retitle the record.', '[]');
select lives_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_b'), 'Proposed', 'Rejected', 'Wrong record.')$$,
  'the requester rejects');
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_b'), 'Rejected', 'Proposed', 'Reconsider.')$$,
  'XR001', 'ai_suggestion_transition_not_allowed: A ai suggestion cannot move from Rejected to Proposed.', 'Rejected is final');
select pg_temp.as_platform();
update app.ai_suggestions set expires_at = now() - interval '1 minute' where id in (pg_temp.id('sug_c'), pg_temp.id('sug_d'));
select pg_temp.as_user('dave');
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 'sug_c'), 'Proposed', 'Confirmed', 'Late.')$$,
  'XR001', 'ai_suggestion_expired: This suggestion has expired. Ask again to get a fresh one.', 'an expired suggestion cannot be confirmed');
select pg_temp.as_platform();
select is(private.expire_ai_suggestions(), 2, 'the expiry job expires every overdue Proposed suggestion');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('sug_d')), 'Expired', 'and records Expired');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('sug_b')), 'Rejected', 'decided suggestions are left alone');

-- Retention
select is((select retention from private.retention_policies where table_name = 'app.ai_requests'), interval '7 years',
  'request logs follow the audit retention rule');
select is((select count(*)::int from private.retention_policies where table_name like 'app.ai\_%'), 6, 'every Aurora table has a retention policy');

select * from finish();
rollback;
