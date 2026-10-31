-- pgTAP: advance answers drafted with Aurora (B15, RRR-239, migration 3044). What may be drafted for a recipient of a
-- sent packet (never Crew Roster, Guest List or File; choices and roster with ids and names), for reviewers only.
-- Recording an accepted draft: through R9's writer (lines become Requested allocations), with its provenance and the
-- suggestion Applied; the source checked again (another project's, an unverified or a discarded message refused); a
-- second draft for an open answer refused advance_answer_pending; the recorder cannot review it and another reviewer
-- can; the provenance is written only by the RPC. Gateway's view keeps R9's columns in order and appends
-- recorded_by_producer and recorded_from_message.
-- World: 0700_engagement_world, 2654_project_facts_world and 2691_allocation_world (Bayside Audio's eng_vendor_a with
-- kai and mo accepted on its roster; dave and erin Coordinators on prj_a, gina viewer, victor Bayside's Account Owner).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

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

create function pg_temp.add_section(p_key text, p_position integer, p_kind text, p_window text, p_max integer, p_per_person boolean) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user('dave');
  insert into app.advance_sections (advance_packet_id, position, title, prompt, section_kind, window_kind, max_lines, per_person)
  values (pg_temp.id('pkt'), p_position, p_kind || ' ' || p_position, 'Tell us your ' || lower(p_kind) || '.',
    p_kind::app.advance_section_kind, p_window::app.advance_window_kind, p_max, p_per_person)
  returning id into v;
  insert into world values (p_key, v);
  return v;
end $$;

-- A drafting request about the recipient and one proposed answer to a section, as dave.
create function pg_temp.draft(p_key text, p_section text, p_fields jsonb) returns uuid
language plpgsql as $$
declare v uuid; r uuid;
begin
  perform pg_temp.as_user('dave');
  r := app.ai_begin_request(pg_temp.id('org_a'), 'drafting', 'claude-sonnet-5-5', 'app.advance_recipients', pg_temp.id('rcp'));
  perform app.ai_complete_request(r, 'Answered', 'Draft answers from [document text/plain].', 'Drafted.', 100, 40);
  v := app.ai_propose_suggestion(r, 'aurora.applyAdvanceAnswer', pg_temp.id(p_section), 'Answer ' || p_section || '.', p_fields);
  insert into world values (p_key, v);
  return v;
end $$;

create function pg_temp.receive(p_key text, p_local text, p_message_id text, p_dkim boolean) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_platform();
  v := app.receive_inbound_email(p_local, 'advance@bayside-audio.test', 'Our advance', p_message_id, p_dkim,
    'Load in at 07:00. We need four radios.', 'raw/' || p_message_id || '.eml');
  insert into world values (p_key, v);
  return v;
end $$;

-- Fixture: a sent packet to Bayside Audio, its inbox mail ------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into app.ai_settings (org_id, drafting_enabled) values (pg_temp.id('org_a'), true);
select pg_temp.as_user('dave');
with x as (insert into app.advance_packets (project_id, title) values (pg_temp.id('prj_a'), 'Vendor Advance') returning id)
insert into world select 'pkt', id from x;
select pg_temp.add_section('s_text', 1, 'Text', null, null, false);
select pg_temp.add_section('s_roster', 2, 'Crew Roster', null, null, false);
select pg_temp.add_section('s_win', 3, 'Schedule Window', 'Load In', 2, false);
select pg_temp.add_section('s_items', 4, 'Item Request', null, 3, false);
select pg_temp.add_section('s_cred', 5, 'Credential Request', null, 5, true);
select pg_temp.add_section('s_guests', 6, 'Guest List', null, null, false);
select pg_temp.add_section('s_file', 7, 'File', null, 2, false);
select pg_temp.as_user('dave');
insert into app.advance_section_choices (advance_section_id, asset_class_id) values (pg_temp.id('s_items'), pg_temp.id('cls_radio'));
insert into app.advance_section_choices (advance_section_id, credential_category_id) values (pg_temp.id('s_cred'), pg_temp.id('cat_crew'));
with x as (insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('cp_v_a'), pg_temp.id('eng_vendor_a')) returning id) insert into world select 'rcp', id from x;
select throws_ok($$select app.draftable_advance_sections((select id from world where key = 'rcp'))$$,
  'XR001', 'advance_packet_unsent: A packet takes answers once it is sent.', 'an unsent packet has nothing to draft');
select app.send_advance_packet(pg_temp.id('pkt'));

select pg_temp.as_user('bob');
create temporary table inbox (project text, local text);
grant select, insert on inbox to public;
insert into inbox values ('prj_a', app.create_project_inbox(pg_temp.id('prj_a'))), ('prj_a2', app.create_project_inbox(pg_temp.id('prj_a2')));
select pg_temp.receive('m_ok', (select local from inbox where project = 'prj_a'), '<a1@bayside-audio.test>', true);
select pg_temp.receive('m_unverified', (select local from inbox where project = 'prj_a'), '<a2@bayside-audio.test>', false);
select pg_temp.receive('m_discarded', (select local from inbox where project = 'prj_a'), '<a3@bayside-audio.test>', true);
select pg_temp.receive('m_other', (select local from inbox where project = 'prj_a2'), '<a4@bayside-audio.test>', true);
select pg_temp.as_user('dave');
select app.discard_inbound_message(pg_temp.id('m_discarded'), 'Duplicate.');

-- What may be drafted -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
create temporary table draftable as select app.draftable_advance_sections(pg_temp.id('rcp')) as d;
select is((select array_agg(s ->> 'kind' order by (s ->> 'title')) from draftable, jsonb_array_elements(d -> 'sections') s),
  array['Credential Request', 'Item Request', 'Schedule Window', 'Text'],
  'Text, Schedule Window, Item Request and Credential Request are drafted, never Crew Roster, Guest List or File');
select is((select s -> 'choices' -> 0 ->> 'asset_class_id' from draftable, jsonb_array_elements(d -> 'sections') s where s ->> 'kind' = 'Item Request'),
  pg_temp.id('cls_radio')::text, 'an item request carries its asset class choices');
select is((select s -> 'choices' -> 0 ->> 'name' from draftable, jsonb_array_elements(d -> 'sections') s where s ->> 'kind' = 'Credential Request'),
  'Crew', 'a credential request carries its category choices by name');
select ok((select jsonb_array_length(d -> 'roster') >= 2 from draftable), 'the engagement''s roster comes with it');
select is((select array_agg(distinct k) from draftable, jsonb_array_elements(d -> 'roster') e, jsonb_object_keys(e) k),
  array['id', 'name'], 'roster entries carry ids and names only');
select is((select d ->> 'time_zone' from draftable), 'America/New_York', 'with the project''s zone');
select pg_temp.as_user('gina');
select throws_ok($$select app.draftable_advance_sections((select id from world where key = 'rcp'))$$,
  '42501', null, 'someone without advancing.submission.review is refused');

-- Recording a draft --------------------------------------------------------------------------------------------------------
select pg_temp.draft('d_text', 's_text', '[{"field_path": "body", "value": "Load in at 07:00 with two trucks.", "confidence": 0.8,
  "source_excerpt": "Load in at 07:00"}]');
select throws_ok($$select app.apply_drafted_advance_answer((select id from world where key = 'd_text'), '{}',
    jsonb_build_object('inbound_message_id', (select id from world where key = 'm_other')))$$,
  'XR001', 'aurora_draft_source_invalid: Aurora drafts from a verified message in this project''s inbox that you can read.',
  'a message of another project is refused');
select throws_ok($$select app.apply_drafted_advance_answer((select id from world where key = 'd_text'), '{}',
    jsonb_build_object('inbound_message_id', (select id from world where key = 'm_unverified')))$$,
  'XR001', 'aurora_draft_source_invalid: Aurora drafts from a verified message in this project''s inbox that you can read.',
  'an unverified message is refused');
select throws_ok($$select app.apply_drafted_advance_answer((select id from world where key = 'd_text'), '{}',
    jsonb_build_object('inbound_message_id', (select id from world where key = 'm_discarded')))$$,
  'XR001', 'aurora_draft_source_invalid: Aurora drafts from a verified message in this project''s inbox that you can read.',
  'a discarded message is refused');
select throws_ok($$select app.apply_drafted_advance_answer((select id from world where key = 'd_text'), '{}',
    jsonb_build_object('inbound_message_id', (select id from world where key = 'm_ok'), 'file_name', 'rider.pdf'))$$,
  'XR001', 'aurora_draft_source_invalid: Name one source: a project inbox message or a file.', 'one source only');
select pg_temp.as_user('erin');
select throws_ok($$select app.apply_drafted_advance_answer((select id from world where key = 'd_text'), '{}',
    jsonb_build_object('file_name', 'rider.pdf'))$$, '42501', null, 'only the person who asked records the draft');
select pg_temp.as_user('dave');
select lives_ok($$insert into world values ('a_text', app.apply_drafted_advance_answer((select id from world where key = 'd_text'), '{}',
    jsonb_build_object('inbound_message_id', (select id from world where key = 'm_ok'))))$$, 'a coordinator records the drafted answer');
select pg_temp.as_platform();
select is((select body from app.advance_submissions where id = pg_temp.id('a_text')), 'Load in at 07:00 with two trucks.', 'the answer holds the draft');
select is((select created_by from app.advance_submissions where id = pg_temp.id('a_text')), pg_temp.id('dave'), 'the recorder is its submitter');
select results_eq($$select ai_suggestion_id, inbound_message_id, source_file_name from app.advance_answer_drafts
    where advance_submission_id = (select id from world where key = 'a_text')$$,
  $$values ((select id from world where key = 'd_text'), (select id from world where key = 'm_ok'), null::text)$$, 'the provenance names the draft and the mail');
select results_eq($$select suggestion_state::text, applied_id from app.ai_suggestions where id = (select id from world where key = 'd_text')$$,
  $$values ('Applied', (select id from world where key = 'a_text'))$$, 'the suggestion is Applied with the answer');

select pg_temp.draft('d_items', 's_items', jsonb_build_array(jsonb_build_object('field_path', 'lines', 'confidence', 0.7,
  'value', jsonb_build_array(jsonb_build_object('asset_class_id', pg_temp.id('cls_radio'), 'quantity', 4)), 'source_excerpt', 'four radios')));
select pg_temp.as_user('dave');
select lives_ok($$insert into world values ('a_items', app.apply_drafted_advance_answer((select id from world where key = 'd_items'),
    '{"note": "Delivered to the FOH riser."}', '{"file_name": "bayside-tour-book.pdf"}'))$$, 'a drafted item request is recorded from a file');
select pg_temp.as_platform();
select is((select count(*)::int from app.advance_allocations al join app.advance_submission_lines l on l.id = al.advance_submission_line_id
    where l.advance_submission_id = pg_temp.id('a_items') and al.allocation_state = 'Requested' and al.quantity = 4), 1,
  'its line is a Requested allocation, as R9 records it');
select is((select source_file_name from app.advance_answer_drafts where advance_submission_id = pg_temp.id('a_items')), 'bayside-tour-book.pdf',
  'the provenance names the file');

select pg_temp.draft('d_items2', 's_items', jsonb_build_array(jsonb_build_object('field_path', 'lines', 'confidence', 0.7,
  'value', jsonb_build_array(jsonb_build_object('asset_class_id', pg_temp.id('cls_radio'), 'quantity', 2)))));
select pg_temp.as_user('dave');
select throws_ok($$select app.apply_drafted_advance_answer((select id from world where key = 'd_items2'), '{}', '{"file_name": "again.pdf"}')$$,
  'XR001', 'advance_answer_pending: This section is answered; answer again only after it is returned.', 'a second draft for an open answer is refused');
select lives_ok($$select app.transition_ai_suggestion((select id from world where key = 'd_items2'), 'Proposed', 'Rejected', 'Already answered.')$$,
  'a drafted answer is rejected on its own');
select pg_temp.draft('d_roster', 's_roster', '[{"field_path": "body", "value": "Kai and Mo.", "confidence": 0.5}]');
select pg_temp.as_user('dave');
select throws_ok($$select app.apply_drafted_advance_answer((select id from world where key = 'd_roster'), '{}', '{"file_name": "crew.pdf"}')$$,
  'XR001', 'advance_section_not_draftable: This section is answered already or no longer takes an answer from Aurora.',
  'a crew roster section is never drafted');

-- Review --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$update app.advance_submissions set review_outcome = 'Accepted' where id = (select id from world where key = 'a_text')$$,
  'XR001', 'sod_advance_submitter: The person who submitted an advance answer cannot review it.', 'the recorder cannot review the answer');
select pg_temp.as_user('carol');
select lives_ok($$update app.advance_submissions set review_outcome = 'Returned', return_reason = 'Say which dock.'
  where id = (select id from world where key = 'a_text')$$, 'another reviewer returns it');
select pg_temp.as_platform();
select is((select review_outcome::text from app.advance_submissions where id = pg_temp.id('a_text')), 'Returned', 'and the answer is Returned');

-- Provenance is written only by the RPC -----------------------------------------------------------------------------------
select pg_temp.as_platform();
select throws_ok($$insert into app.advance_answer_drafts (advance_submission_id, ai_suggestion_id, source_file_name)
    values ((select id from world where key = 'a_text'), (select id from world where key = 'd_items2'), 'x.pdf')$$,
  'XR001', 'ai_suggestion_batch_apply: An answer drafted with Aurora is recorded from the Aurora preview.', 'no direct provenance insert');
select is(pg_temp.n('dave', 'select 1 from app.advance_answer_drafts'), 2, 'a packet reader reads the provenance');
select is(pg_temp.n('xavier', 'select 1 from app.advance_answer_drafts'), 0, 'another org does not');

-- What Gateway reads ------------------------------------------------------------------------------------------------------
select is((select array_agg(a.attname::text order by a.attnum) from pg_attribute a
    where a.attrelid = 'api_external.advance_submissions'::regclass and a.attnum > 0 and not a.attisdropped),
  array['id', 'advance_section_id', 'advance_recipient_id', 'body', 'submitted_at', 'reviewed_at', 'review_outcome', 'return_reason',
    'answer_note', 'recorded_by_producer', 'recorded_from_message'],
  'the view keeps every R9 column in order and appends the two labels');
select is(pg_temp.n('victor', 'select 1 from api_external.advance_submissions where recorded_by_producer and recorded_from_message'), 1,
  'the party reads the answer recorded from the inbox mail');
select is(pg_temp.n('victor', 'select 1 from api_external.advance_submissions where recorded_by_producer and not recorded_from_message'), 1,
  'and the one recorded from a file');
select pg_temp.as_user('victor');
select is(app.submit_advance_answer(pg_temp.id('rcp'), pg_temp.id('s_text'), 'Dock 2, two trucks.') is not null, true,
  'the party answers the returned section itself');
select is(pg_temp.n('victor', 'select 1 from api_external.advance_submissions where not recorded_by_producer'), 1,
  'and its own answer carries no label');

select ok(not has_function_privilege('anon', 'app.apply_drafted_advance_answer(uuid, jsonb, jsonb)', 'execute'), 'anon cannot record');
select ok(not has_function_privilege('authenticated', 'private.advance_section_draftable(uuid, uuid)', 'execute'), 'the draftable rule is private');

select * from finish();
rollback;
