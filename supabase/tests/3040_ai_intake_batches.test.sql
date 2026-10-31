-- pgTAP: Aurora intake batches (B15, RRR-239, migration 3040). Starting a batch: the capabilities of each kind, a Travel
-- fulfillment of the project, the plan, the extraction switch and the allowance, the file count check. Who reads a batch.
-- Requests about a batch: only its creator's extraction requests, while open and below the file count, a failed file
-- retried, refusals leaving no request or usage row. Closing. Batch-applied suggestions refuse confirming one at a time
-- and still reject; other suggestions are unchanged. Restricted proposed fields: set by the database, refused without
-- payroll, hidden from an audit reader without it. Trash sync and privileges.
-- World: 0700_engagement_world (org_a Northwind Live on Team; alice owner, bob admin, carol manager, dave and erin
-- project Coordinators on prj_a, gina viewer).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- An extraction request about a batch, started as whoever is signed in.
create function pg_temp.batch_request(p_batch text) returns uuid
language sql as $$
  select app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5', 'app.ai_intake_batches', pg_temp.id(p_batch))
$$;

select pg_temp.as_user('bob');
insert into app.ai_settings (org_id, extraction_enabled, drafting_enabled) values (pg_temp.id('org_a'), true, true);
select pg_temp.as_user('dave');
with x as (insert into app.fulfillments (project_id, fulfillment_kind, title) values (pg_temp.id('prj_a'), 'Travel', 'Artist Travel') returning id)
  insert into world select 'ful_travel', id from x;
with x as (insert into app.fulfillments (project_id, fulfillment_kind, title) values (pg_temp.id('prj_a'), 'Catering', 'Crew Meals') returning id)
  insert into world select 'ful_catering', id from x;
select pg_temp.as_platform();

-- Starting a batch ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$insert into world values ('b_trip', app.start_ai_intake((select id from world where key = 'prj_a'), 'Itineraries', 2,
  (select id from world where key = 'ful_travel')))$$, 'a coordinator with hospitality.fulfillment.write opens an itinerary intake');
select is((select closed_at from app.ai_intake_batches where id = pg_temp.id('b_trip')), null, 'the batch opens');
select is((select created_by from app.ai_intake_batches where id = pg_temp.id('b_trip')), pg_temp.id('dave'), 'the batch is the caller''s');
select throws_ok($$select app.start_ai_intake((select id from world where key = 'prj_a'), 'Itineraries', 2, (select id from world where key = 'ful_catering'))$$,
  'XR001', 'travel_fulfillment_kind: A travel segment belongs to a Travel fulfillment.', 'a Catering fulfillment is refused');
select throws_ok($$select app.start_ai_intake((select id from world where key = 'prj_a2'), 'Itineraries', 2, (select id from world where key = 'ful_travel'))$$,
  '42501', null, 'another project without the capability is refused before its fulfillment');
select throws_ok($$select app.start_ai_intake((select id from world where key = 'prj_a'), 'Contracts and Riders', 2)$$,
  '42501', null, 'a coordinator without opportunities.engagement.write cannot open a contract intake');
select throws_ok($$select app.start_ai_intake((select id from world where key = 'prj_a'), 'Itineraries', 0)$$,
  '23514', null, 'a file count below 1 violates the check');
select throws_ok($$select app.start_ai_intake((select id from world where key = 'prj_a'), 'Itineraries', 26)$$,
  '23514', null, 'a file count above 25 violates the check');
select pg_temp.as_user('gina');
select throws_ok($$select app.start_ai_intake((select id from world where key = 'prj_a'), 'Itineraries', 1)$$,
  '42501', null, 'a Viewer is refused');
select pg_temp.as_user('xavier');
select throws_ok($$select app.start_ai_intake((select id from world where key = 'prj_a'), 'Itineraries', 1)$$,
  '42501', null, 'another org is refused');
select pg_temp.as_user('carol');
select lives_ok($$insert into world values ('b_contracts', app.start_ai_intake((select id from world where key = 'prj_a'), 'Contracts and Riders', 3))$$,
  'a manager opens a contract intake');
select throws_ok($$select app.start_ai_intake((select id from world where key = 'prj_a'), 'Contracts and Riders', 3, (select id from world where key = 'ful_travel'))$$,
  'XR001', 'travel_fulfillment_kind: A travel segment belongs to a Travel fulfillment.', 'only an itinerary intake takes a fulfillment');

-- The allowance covers every file before any is read.
select pg_temp.as_platform();
update private.plan_limits set limit_value = private.ai_requests_this_month(pg_temp.id('org_a')) + 3
where plan_code = 'team' and limit_code = 'aurora_requests_per_month';
select pg_temp.as_user('dave');
select throws_ok($$select app.start_ai_intake((select id from world where key = 'prj_a'), 'Itineraries', 4)$$,
  'XR001', null, 'four files do not fit in three requests left');
select lives_ok($$select app.start_ai_intake((select id from world where key = 'prj_a'), 'Itineraries', 3)$$, 'three files fit');
select pg_temp.as_platform();
update private.plan_limits set limit_value = 10000 where plan_code = 'team' and limit_code = 'aurora_requests_per_month';
select pg_temp.as_user('bob');
update app.ai_settings set extraction_enabled = false where org_id = pg_temp.id('org_a');
select pg_temp.as_user('dave');
select throws_ok($$select app.start_ai_intake((select id from world where key = 'prj_a'), 'Itineraries', 1)$$,
  'XR001', 'aurora_feature_off: An Admin has not turned on extraction in Settings, AI Features.', 'extraction switched off is refused');
select pg_temp.as_user('bob');
update app.ai_settings set extraction_enabled = true where org_id = pg_temp.id('org_a');

-- Who reads a batch ----------------------------------------------------------------------------------------------------
select is(pg_temp.n('dave', 'select 1 from app.ai_intake_batches where id = (select id from world where key = ''b_trip'')'), 1, 'its creator reads the batch');
select is(pg_temp.n('bob', 'select 1 from app.ai_intake_batches where id = (select id from world where key = ''b_trip'')'), 1, 'an audit.log.read holder reads it');
select is(pg_temp.n('erin', 'select 1 from app.ai_intake_batches where id = (select id from world where key = ''b_trip'')'), 0, 'another coordinator does not');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.ai_intake_batches (project_id, intake_kind, file_count) values ((select id from world where key = 'prj_a'), 'Itineraries', 1)$$,
  '42501', null, 'no direct insert');
select throws_ok($$update app.ai_intake_batches set file_count = 25 where id = (select id from world where key = 'b_trip')$$,
  '42501', null, 'no direct update');

-- Requests about a batch -------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$insert into world values ('r1', pg_temp.batch_request('b_trip'))$$, 'the first file is read');
select lives_ok($$insert into world values ('r2', pg_temp.batch_request('b_trip'))$$, 'the second file is read');
select throws_ok($$select pg_temp.batch_request('b_trip')$$,
  'XR001', 'aurora_intake_full: This intake reads 2 files and has read them all. Start a new one for more.', 'a third file is beyond the file count');
select pg_temp.as_platform();
select is((select count(*)::int from app.ai_requests where subject_id = pg_temp.id('b_trip')), 2, 'the refused file left no request');
select is((select count(*)::int from app.ai_usage u join app.ai_requests r on r.id = u.request_id where r.subject_id = pg_temp.id('b_trip')), 2,
  'and no usage row');
select pg_temp.as_user('dave');
select app.ai_complete_request(pg_temp.id('r2'), 'Failed', '', null, null, null, 'model_error');
select lives_ok($$insert into world values ('r3', pg_temp.batch_request('b_trip'))$$, 'a failed file is read again within the file count');
select pg_temp.as_platform();
select is((select count(*)::int from app.ai_usage u join app.ai_requests r on r.id = u.request_id where r.subject_id = pg_temp.id('b_trip')), 3,
  'and the retry is metered');
select pg_temp.as_user('erin');
select throws_ok($$select pg_temp.batch_request('b_trip')$$, '42501', null, 'another person reads no file into the batch');
select pg_temp.as_user('dave');
select throws_ok($$select app.ai_begin_request((select id from world where key = 'org_a'), 'drafting', 'claude-sonnet-5-5', 'app.ai_intake_batches',
  (select id from world where key = 'b_trip'))$$, '42501', null, 'a batch takes extraction requests only');

-- Batch-applied suggestions -------------------------------------------------------------------------------------------------
select app.ai_complete_request(pg_temp.id('r1'), 'Answered', 'Read the itinerary.', 'Two segments.', 100, 40);
insert into world values ('s_seg', app.ai_propose_suggestion(pg_temp.id('r1'), 'aurora.applyItineraries', null, 'Add a segment.',
  '[{"field_path": "departs_from", "value": "MIA", "confidence": 0.9, "source_excerpt": "MIA 08:15"}]'));
insert into world values ('s_seg2', app.ai_propose_suggestion(pg_temp.id('r1'), 'aurora.applyItineraries', null, 'Add a segment.',
  '[{"field_path": "departs_from", "value": "JFK", "confidence": 0.9}]'));
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 's_seg'), 'Proposed', 'Confirmed', 'One at a time.')$$,
  'XR001', 'ai_suggestion_batch_apply: Add these together from the Aurora preview, so nothing is written piecemeal.',
  'a suggestion of an intake batch is not confirmed on its own');
select lives_ok($$select app.transition_ai_suggestion((select id from world where key = 's_seg2'), 'Proposed', 'Rejected', 'Not this one.')$$,
  'and can still be rejected on its own');
insert into world values ('r_adv', app.ai_begin_request(pg_temp.id('org_a'), 'drafting', 'claude-sonnet-5-5', 'app.advance_recipients', pg_temp.id('prj_a')));
select app.ai_complete_request(pg_temp.id('r_adv'), 'Answered', 'Draft answers.', 'One answer.', 100, 40);
insert into world values ('s_adv', app.ai_propose_suggestion(pg_temp.id('r_adv'), 'aurora.applyAdvanceAnswer', pg_temp.id('prj_a'), 'Answer a section.',
  '[{"field_path": "body", "value": "Two trucks.", "confidence": 0.8}]'));
select throws_ok($$select app.transition_ai_suggestion((select id from world where key = 's_adv'), 'Proposed', 'Confirmed', 'One at a time.')$$,
  'XR001', 'ai_suggestion_batch_apply: Add these together from the Aurora preview, so nothing is written piecemeal.',
  'a drafted advance answer is not confirmed on its own');
insert into world values ('r_doc', app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5', 'app.documents', pg_temp.id('prj_a')));
select app.ai_complete_request(pg_temp.id('r_doc'), 'Answered', 'q', 'a');
insert into world values ('s_doc', app.ai_propose_suggestion(pg_temp.id('r_doc'), 'insuranceCertificates.create', null, 'Add the certificate.',
  '[{"field_path": "insurer", "value": "Atlantic Mutual", "confidence": 0.9}]'));
select lives_ok($$select app.transition_ai_suggestion((select id from world where key = 's_doc'), 'Proposed', 'Confirmed', 'Checked.')$$,
  'an extraction suggestion about a document still confirms on its own');

-- Closing -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select throws_ok($$select app.close_ai_intake((select id from world where key = 'b_trip'))$$, '42501', null, 'only the creator closes a batch');
select pg_temp.as_user('dave');
select is(app.close_ai_intake(pg_temp.id('b_trip')), 1, 'closing rejects the batch''s one open suggestion');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('s_seg')), 'Rejected', 'which is now Rejected');
select isnt((select closed_at from app.ai_intake_batches where id = pg_temp.id('b_trip')), null, 'the batch is closed');
select throws_ok($$select pg_temp.batch_request('b_trip')$$,
  'XR001', 'aurora_intake_closed: This intake is closed. Start a new one to read more files.', 'a closed batch reads no file');
select throws_ok($$select app.close_ai_intake((select id from world where key = 'b_trip'))$$,
  'XR001', 'aurora_intake_closed: This intake is closed. Start a new one to read more files.', 'a batch closes once');
select pg_temp.as_platform();
select is((select count(*)::int from app.ai_usage u join app.ai_requests r on r.id = u.request_id where r.subject_id = pg_temp.id('b_trip')), 3,
  'the refusals metered nothing');

-- Restricted proposed fields ------------------------------------------------------------------------------------------------
create function pg_temp.contract_request(p_key text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  v := app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5');
  perform app.ai_complete_request(v, 'Answered', 'Read the contract.', 'Read.', 100, 40);
  insert into world values (p_key, v);
  return v;
end $$;

select pg_temp.as_user('alice');
select pg_temp.contract_request('r_fee_alice');
select lives_ok($$insert into world values ('s_fee', app.ai_propose_suggestion((select id from world where key = 'r_fee_alice'), 'aurora.applyContracts', null,
  'Book the act.', '[{"field_path": "act_name", "value": "The Midnight Owls", "confidence": 0.9, "restricted_capability": "data.restricted.read.payroll"},
    {"field_path": "fee_minor", "value": 750000, "confidence": 0.9, "source_excerpt": "[Restricted]", "restricted_capability": null}]'))$$,
  'a payroll reader stores a proposed fee');
select pg_temp.as_platform();
select is((select restricted_capability from app.ai_suggestion_fields where suggestion_id = pg_temp.id('s_fee') and field_path = 'fee_minor'),
  'data.restricted.read.payroll', 'the database marks the fee Restricted, whatever the caller sent');
select is((select restricted_capability from app.ai_suggestion_fields where suggestion_id = pg_temp.id('s_fee') and field_path = 'act_name'),
  null, 'and never marks another field from the caller''s say');
select is(pg_temp.n('alice', 'select 1 from app.ai_suggestion_fields where suggestion_id = (select id from world where key = ''s_fee'')'), 2,
  'the payroll reader who asked reads both fields');
select is(pg_temp.n('bob', 'select 1 from app.ai_suggestions where id = (select id from world where key = ''s_fee'')'), 1,
  'an audit reader reads the suggestion');
select is(pg_temp.n('bob', 'select 1 from app.ai_suggestion_fields where suggestion_id = (select id from world where key = ''s_fee'')'), 1,
  'but not its fee, without payroll');
select pg_temp.as_user('carol');
select pg_temp.contract_request('r_fee_carol');
select throws_ok($$select app.ai_propose_suggestion((select id from world where key = 'r_fee_carol'), 'aurora.applyContracts', null, 'Book the act.',
  '[{"field_path": "fee_minor", "value": 750000, "confidence": 0.9}]')$$,
  'XR001', 'aurora_field_restricted: This value is Restricted and was not read for you.', 'a fee from a caller without payroll is refused');
select lives_ok($$insert into world values ('s_nofee', app.ai_propose_suggestion((select id from world where key = 'r_fee_carol'), 'aurora.applyContracts', null,
  'Book the act.', '[{"field_path": "fee_minor", "refusal": "NO_ANSWER", "missing": "Fees are read only by someone who may see pay rates."}]'))$$,
  'a NO_ANSWER fee is stored for them');
select is(pg_temp.n('carol', 'select 1 from app.ai_suggestion_fields where suggestion_id = (select id from world where key = ''s_nofee'') and missing is not null'), 1,
  'and they read why: with no value and no excerpt it holds nothing Restricted');
select is((select restricted_capability from app.ai_suggestion_fields where suggestion_id = pg_temp.id('s_nofee')), null,
  'so the database leaves it unmarked');
select pg_temp.as_user('carol');
select lives_ok($$insert into world values ('s_excerpt', app.ai_propose_suggestion((select id from world where key = 'r_fee_carol'), 'aurora.applyContracts', null,
  'Book the act.', '[{"field_path": "fee_minor", "refusal": "NO_ANSWER", "missing": "Not read.", "source_excerpt": "Guarantee: USD 7,500"}]'))$$,
  'an excerpt without a value is stored');
select is(pg_temp.n('carol', 'select 1 from app.ai_suggestion_fields where suggestion_id = (select id from world where key = ''s_excerpt'')'), 0,
  'but an excerpt can quote the fee, so it stays hidden as Restricted');

-- Trash and privileges -----------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(private.sync_trash_tables(), 0, 'Trash is already in sync after 3040 and 3044');
select ok(not exists (select 1 from private.trash_tables where table_name in ('ai_intake_batches', 'advance_answer_drafts')),
  'neither new table is in Trash: they carry no title');
select ok(not has_function_privilege('anon', 'app.start_ai_intake(uuid, app.ai_intake_kind, integer, uuid)', 'execute'), 'anon cannot open a batch');
select ok(has_function_privilege('authenticated', 'app.close_ai_intake(uuid)', 'execute'), 'members close their batches');
select ok(not has_function_privilege('authenticated', 'private.guard_intake_request()', 'execute'), 'the request guard is not callable');
select ok(not has_function_privilege('authenticated', 'private.aurora_batch_apply_only()', 'execute'), 'the apply guard is not callable');
select ok(not has_table_privilege('authenticated', 'private.ai_restricted_fields', 'select'), 'the Restricted field list is private');
select ok((select prosecdef from pg_proc where oid = 'app.ai_propose_suggestion(uuid, text, uuid, text, jsonb)'::regprocedure),
  'ai_propose_suggestion stays security definer');

select * from finish();
rollback;
