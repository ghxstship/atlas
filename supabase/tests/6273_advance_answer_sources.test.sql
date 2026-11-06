-- pgTAP: advance answers drafted from a reply (B15, RRR-239, migration 6273; ADR 0154 D1). What may be drafted: Text, Schedule
-- Window and non-per-person Item and Credential sections, never Guest List, File, Crew Roster or per-person; Item and
-- Credential need packet.write too. Recording goes through R9's writer with its rules, re-reads mail and refuses what the
-- suggestion's fields merely claim. The accepter cannot review it, a second person can; lines become Requested allocations;
-- the recipient side is notified. The source row survives the mail's purge, and Gateway's view appends recorded_by_producer.
-- World: 0700_engagement_world, 2654_project_facts_world and 2691_allocation_world (Bayside Audio's eng_vendor_a; dave and erin
-- Coordinators on prj_a, gina viewer, victor Bayside's Account Owner).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 4654_project_facts_world.psql
\ir 4691_allocation_world.psql

select no_plan();

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
create function pg_temp.draft(p_key text, p_section text, p_fields jsonb, p_recipient text default 'rcp') returns uuid
language plpgsql as $$
declare v uuid; r uuid;
begin
  perform pg_temp.as_user('dave');
  r := app.ai_begin_request(pg_temp.id('org_a'), 'drafting', 'claude-sonnet-5-5', 'app.advance_recipients', pg_temp.id(p_recipient));
  perform app.ai_complete_request(r, 'Answered', 'Draft answers from [document text/plain].', 'Drafted.', 100, 40);
  v := app.ai_propose_suggestion(r, 'advanceAnswers.record', pg_temp.id(p_section), 'Answer ' || p_section || '.', p_fields);
  insert into world values (p_key, v);
  return v;
end $$;

create function pg_temp.file_fields(p_more jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('field_path', 'source_kind', 'value', 'File', 'confidence', 0.8, 'source_excerpt', 'We load in at 07:00.'),
    jsonb_build_object('field_path', 'file_name', 'value', 'tour-book.pdf', 'confidence', 1)) || p_more
$$;

create function pg_temp.mail_fields(p_message text, p_excerpt text, p_more jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_array(
    jsonb_build_object('field_path', 'source_kind', 'value', 'Project Inbox', 'confidence', 0.8, 'source_excerpt', p_excerpt),
    jsonb_build_object('field_path', 'inbound_message_id', 'value', pg_temp.id(p_message), 'confidence', 1)) || p_more
$$;

create function pg_temp.receive(p_key text, p_local text, p_message_id text, p_dkim boolean, p_body text default 'Load in at 07:00. We need four radios.') returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_platform();
  v := app.receive_inbound_email(p_local, 'advance@bayside-audio.test', 'Our advance', p_message_id, p_dkim, p_body, 'raw/' || p_message_id || '.eml');
  insert into world values (p_key, v);
  return v;
end $$;

-- Fixture -----------------------------------------------------------------------------------------------------------------------
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
select pg_temp.add_section('s_text2', 8, 'Text', null, null, false);
select pg_temp.add_section('s_text3', 9, 'Text', null, null, false);
select pg_temp.as_user('dave');
with x as (insert into app.advance_section_choices (advance_section_id, asset_class_id) values (pg_temp.id('s_items'), pg_temp.id('cls_radio')) returning id)
insert into world select 'choice_radio', id from x;
insert into app.advance_section_choices (advance_section_id, credential_category_id) values (pg_temp.id('s_cred'), pg_temp.id('cat_crew'));
with x as (insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('cp_v_a'), pg_temp.id('eng_vendor_a')) returning id) insert into world select 'rcp', id from x;
select throws_ok($$select app.advance_draft_scope((select id from world where key = 'rcp'))$$,
  'XR001', 'advance_packet_unsent: A packet takes answers once it is sent.', 'an unsent packet has nothing to draft');
with x as (insert into app.advance_recipients (advance_packet_id, person_id)
  values (pg_temp.id('pkt'), pg_temp.id('ivy')) returning id) insert into world select 'rcp_person', id from x;
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

-- Scope ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
create temporary table scope as select app.advance_draft_scope(pg_temp.id('rcp')) as d;
grant select on scope to public;
select is((select array_agg(distinct s ->> 'kind' order by s ->> 'kind') from scope, jsonb_array_elements(d -> 'sections') s),
  array['Item Request', 'Schedule Window', 'Text'], 'Text, Schedule Window and non-per-person lines are offered, never Crew Roster, Guest List, File or per-person');
select ok((select d ? 'time_zone' and not d ? 'roster' from scope), 'the project''s zone goes with them, and no roster');
select is((select s -> 'choices' -> 0 ->> 'id' from scope, jsonb_array_elements(d -> 'sections') s where s ->> 'kind' = 'Item Request'), (select id::text from world where key = 'choice_radio'), 'a choice is its section choice');
select is((select array_agg(distinct s ->> 'kind' order by s ->> 'kind') from jsonb_array_elements(app.advance_draft_scope(pg_temp.id('rcp_person')) -> 'sections') s),
  array['Schedule Window', 'Text'], 'a recipient with no engagement is offered no Item or Credential section');
select pg_temp.as_user('gina');
select throws_ok($$select app.advance_draft_scope((select id from world where key = 'rcp'))$$, '42501', null, 'without review it is refused');

-- Refusals --------------------------------------------------------------------------------------------------------------------
select pg_temp.draft('d_guests', 's_guests', pg_temp.file_fields('[{"field_path": "text", "value": "Yes", "confidence": 0.8}]'));
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_guests'))$$,
  'XR001', 'aurora_advance_section_not_allowed: Aurora does not record an answer to this section.', 'a Guest List is refused');
select pg_temp.draft('d_file', 's_file', pg_temp.file_fields('[{"field_path": "text", "value": "Yes", "confidence": 0.8}]'));
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_file'))$$,
  'XR001', 'aurora_advance_section_not_allowed: Aurora does not record an answer to this section.', 'a File is refused');
select pg_temp.draft('d_roster', 's_roster', pg_temp.file_fields('[{"field_path": "text", "value": "Yes", "confidence": 0.8}]'));
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_roster'))$$,
  'XR001', 'aurora_advance_section_not_allowed: Aurora does not record an answer to this section.', 'a Crew Roster is refused');
select pg_temp.draft('d_person', 's_cred', pg_temp.file_fields('[{"field_path": "lines", "value": [], "confidence": 0.8}]'));
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_person'))$$,
  'XR001', 'aurora_advance_section_not_allowed: Aurora does not record an answer to this section.', 'a per-person section is refused');

-- Suggestion fields are not proof: the mail is read again.
select pg_temp.draft('d_unverified', 's_text', pg_temp.mail_fields('m_unverified', 'Load in at 07:00.', '[{"field_path": "text", "value": "07:00", "confidence": 0.8}]'));
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_unverified'))$$,
  'XR001', 'aurora_advance_source_unverified: This answer was not read from verified mail in this project''s inbox that you can read.', 'unverified mail is refused');
select pg_temp.draft('d_discarded', 's_text', pg_temp.mail_fields('m_discarded', 'Load in at 07:00.', '[{"field_path": "text", "value": "07:00", "confidence": 0.8}]'));
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_discarded'))$$,
  'XR001', 'aurora_advance_source_unverified: This answer was not read from verified mail in this project''s inbox that you can read.', 'discarded mail is refused');
select pg_temp.draft('d_other', 's_text', pg_temp.mail_fields('m_other', 'Load in at 07:00.', '[{"field_path": "text", "value": "07:00", "confidence": 0.8}]'));
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_other'))$$,
  'XR001', 'aurora_advance_source_unverified: This answer was not read from verified mail in this project''s inbox that you can read.', 'another project''s mail is refused');
select pg_temp.draft('d_invented', 's_text', pg_temp.mail_fields('m_ok', 'Load in at 09:00.', '[{"field_path": "text", "value": "09:00", "confidence": 0.8}]'));
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_invented'))$$,
  'XR001', 'aurora_advance_source_unverified: This answer was not read from verified mail in this project''s inbox that you can read.', 'an excerpt the mail does not hold is refused');
select pg_temp.draft('d_spaces', 's_text3', pg_temp.mail_fields('m_ok', 'Load   in at
07:00.', '[{"field_path": "text", "value": "07:00", "confidence": 0.8}]'));
select lives_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_spaces'))$$, 'an excerpt matches after whitespace is normalized');

-- A suggestion that targets another recipient's section, or names a choice from nowhere.
select pg_temp.draft('d_foreign_choice', 's_items', pg_temp.file_fields(jsonb_build_array(jsonb_build_object('field_path', 'lines', 'confidence', 0.8,
  'value', jsonb_build_array(jsonb_build_object('choice_id', pg_temp.id('rcp'), 'quantity', 2))))));
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_foreign_choice'))$$,
  'XR001', 'advance_line_kind: A line names one of the section''s choices.', 'a choice of no section is refused');
select pg_temp.draft('d_quantity', 's_items', pg_temp.file_fields(jsonb_build_array(jsonb_build_object('field_path', 'lines', 'confidence', 0.8,
  'value', jsonb_build_array(jsonb_build_object('choice_id', pg_temp.id('choice_radio'), 'quantity', 10001))))));
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_quantity'))$$,
  'XR001', 'advance_line_kind: A quantity runs from 1 to 10,000.', 'a quantity past 10,000 is refused');
select pg_temp.draft('d_note', 's_items', pg_temp.file_fields(jsonb_build_array(jsonb_build_object('field_path', 'lines', 'confidence', 0.8,
  'value', jsonb_build_array(jsonb_build_object('choice_id', pg_temp.id('choice_radio'), 'quantity', 2, 'note', repeat('x', 501)))))));
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_note'))$$,
  'XR001', 'advance_line_kind: A line note runs at most 500 characters.', 'a note past 500 characters is refused');
select pg_temp.draft('d_key', 's_items', pg_temp.file_fields(jsonb_build_array(jsonb_build_object('field_path', 'lines', 'confidence', 0.8,
  'value', jsonb_build_array(jsonb_build_object('choice_id', pg_temp.id('choice_radio'), 'quantity', 2, 'roster_entry_id', pg_temp.id('rcp')))))));
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_key'))$$,
  'XR001', 'advance_line_kind: A line cannot set roster_entry_id.', 'a line cannot name a person');

-- Another person's suggestion.
select pg_temp.as_user('erin');
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_key'))$$, '42501', null, 'someone else''s suggestion is refused');

-- Review alone records Text and windows, not requests for the party.
select pg_temp.draft('d_items_nowrite', 's_items', pg_temp.file_fields(jsonb_build_array(jsonb_build_object('field_path', 'lines', 'confidence', 0.8,
  'value', jsonb_build_array(jsonb_build_object('choice_id', pg_temp.id('choice_radio'), 'quantity', 2))))));
select pg_temp.as_platform();
create temp table held_packet_write on commit drop as
  with gone as (delete from app.role_capabilities where capability_code = 'advancing.packet.write' returning *) select * from gone;
select pg_temp.as_user('dave');
select is((select array_agg(distinct s ->> 'kind' order by s ->> 'kind') from jsonb_array_elements(app.advance_draft_scope(pg_temp.id('rcp')) -> 'sections') s),
  array['Schedule Window', 'Text'], 'review alone is offered Text and Schedule Window');
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_items_nowrite'))$$,
  '42501', 'recording items or credentials for a party needs advancing.packet.write on the packet''s project', 'and cannot record an item request');
select pg_temp.as_platform();
insert into app.role_capabilities select * from held_packet_write;

-- Recording ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select pg_temp.draft('d_text', 's_text2', pg_temp.mail_fields('m_ok', 'Load in at 07:00.', '[{"field_path": "text", "value": "Load in at 07:00.", "confidence": 0.8}, {"field_path": "note", "value": "dropped", "confidence": 0.8}]'));
select pg_temp.as_platform();
create temporary table notices_before as select count(*)::int as n from app.notifications where kind = 'advance_answer.recorded';
grant select on notices_before to public;
select pg_temp.as_user('dave');
insert into world values ('a_text', app.record_drafted_advance_answer(pg_temp.id('d_text'), '{"text": "Load in at 07:00, gate B."}'));
select pg_temp.as_platform();
select is((select body from app.advance_submissions where id = pg_temp.id('a_text')), 'Load in at 07:00, gate B.', 'a corrected answer is recorded');
select is((select note from app.advance_submissions where id = pg_temp.id('a_text')), null, 'a Text answer''s note is dropped, not refused');
select is((select created_by from app.advance_submissions where id = pg_temp.id('a_text')), pg_temp.id('dave'), 'the accepter is the submitter');
select is((select source_kind::text from app.advance_answer_sources where advance_submission_id = pg_temp.id('a_text')), 'Project Inbox', 'with its source');
select is((select source_excerpt from app.advance_answer_sources where advance_submission_id = pg_temp.id('a_text')), 'Load in at 07:00.', 'and its excerpt');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('d_text')), 'Applied', 'the suggestion ends Applied');
select is((select applied_id from app.ai_suggestions where id = pg_temp.id('d_text')), pg_temp.id('a_text'), 'with the answer');
select ok((select count(*)::int from app.notifications where kind = 'advance_answer.recorded') > (select n from notices_before), 'the recipient side is notified');
select is((select count(*)::int from app.notifications where kind = 'advance_answer.recorded' and recipient_person_id = pg_temp.id('victor') and subject_id = pg_temp.id('a_text')), 1, 'the account owner is told');
select is((select count(*)::int from app.notifications where kind = 'advance_answer.recorded' and recipient_person_id = pg_temp.id('dave')), 0, 'never the actor');

select pg_temp.as_user('dave');
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_text'))$$,
  'XR001', 'ai_suggestion_transition_not_allowed: This answer was already decided.', 're-applying a suggestion is refused');
select pg_temp.draft('d_again', 's_text2', pg_temp.file_fields('[{"field_path": "text", "value": "Again", "confidence": 0.8}]'));
select throws_ok($$select app.record_drafted_advance_answer((select id from world where key = 'd_again'))$$,
  'XR001', 'advance_answer_pending: This section is answered; answer again only after it is returned.', 'an open answer blocks another');

-- A second person reviews; lines become Requested allocations with the accepter as requester.
select pg_temp.draft('d_win', 's_win', pg_temp.file_fields('[{"field_path": "lines", "confidence": 0.8, "value": [{"needed_window_start": "2027-06-01T11:00:00Z", "needed_window_end": "2027-06-01T15:00:00Z", "window_zone": "America/New_York", "note": "dropped"}]}]'));
insert into world values ('a_win', app.record_drafted_advance_answer(pg_temp.id('d_win')));
select pg_temp.as_platform();
select is((select count(*)::int from app.advance_submission_lines where advance_submission_id = pg_temp.id('a_win') and note is null), 1, 'a window line''s note is dropped, not refused');
select pg_temp.draft('d_item', 's_items', pg_temp.file_fields(jsonb_build_array(jsonb_build_object('field_path', 'lines', 'confidence', 0.8,
  'value', jsonb_build_array(jsonb_build_object('choice_id', pg_temp.id('choice_radio'), 'quantity', 2))))));
insert into world values ('a_item', app.record_drafted_advance_answer(pg_temp.id('d_item')));
select pg_temp.as_platform();
select is((select count(*)::int from app.advance_allocations al join app.advance_submission_lines l on l.id = al.advance_submission_line_id where l.advance_submission_id = pg_temp.id('a_item') and al.allocation_state = 'Requested' and al.created_by = pg_temp.id('dave')), 1, 'an item line is a Requested allocation with the accepter as requester');
select pg_temp.as_user('dave');
select throws_ok($$update app.advance_submissions set review_outcome = 'Accepted' where id = (select id from world where key = 'a_text')$$,
  'XR001', 'sod_advance_submitter: The person who submitted an advance answer cannot review it.', 'the accepter cannot review it');
select pg_temp.as_user('erin');
select lives_ok($$update app.advance_submissions set review_outcome = 'Accepted' where id = (select id from world where key = 'a_text')$$, 'a second person can');

-- Reading -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select is((select count(*)::int from app.advance_answer_sources where advance_submission_id = pg_temp.id('a_text')), 1, 'a packet reader reads the source');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.advance_answer_sources where advance_submission_id = pg_temp.id('a_text')), 0, 'someone outside does not');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.advance_answer_sources (advance_submission_id, source_kind, file_name, source_excerpt) values ((select id from world where key = 'a_text'), 'File', 'x.pdf', 'x')$$,
  '42501', null, 'nothing writes a source but the RPC');
select pg_temp.as_user('victor');
select ok((select recorded_by_producer from api_external.advance_submissions where id = pg_temp.id('a_text')), 'Gateway''s view says the producer recorded it');
select is((select array_agg(c.column_name::text order by c.ordinal_position) from information_schema.columns c where c.table_schema = 'api_external' and c.table_name = 'advance_submissions'),
  array['id', 'advance_section_id', 'advance_recipient_id', 'body', 'submitted_at', 'reviewed_at', 'review_outcome', 'return_reason', 'answer_note', 'recorded_by_producer'],
  'it keeps R9''s columns in order and appends one');

-- Retention: the source outlives the mail, which is purged at 2 years.
select pg_temp.as_platform();
select private.begin_trusted_operation('retention_purge');
delete from app.inbound_messages where id = pg_temp.id('m_ok');
select private.end_trusted_operation('retention_purge');
select is((select inbound_message_id from app.advance_answer_sources where advance_submission_id = pg_temp.id('a_text')), null::uuid, 'purging the mail keeps the source row, with the id null');
select is((select source_excerpt from app.advance_answer_sources where advance_submission_id = pg_temp.id('a_text')), 'Load in at 07:00.', 'and its excerpt');

select * from finish();
rollback;
