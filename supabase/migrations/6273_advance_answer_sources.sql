-- 3043_advance_answer_sources.sql
-- B15 advance answers drafted from a reply (RRR-239, parity gap G-173; ADR 0154 D1). A person who reviews advance answers
-- has Aurora read a project inbox message or a file the party sent into proposed answers for the recipient's open sections,
-- and records each answer they accept. The accepter is the answer's submitter, so sod_advance_submitter sends it to a
-- second reviewer. Never drafted: Guest List (the recipient's own confirmation), File, Crew Roster, any per-person
-- section and any project fact (Advancing decision 0/1, ADR 0100 decision 1).
--
--   1. app.advance_answer_sources: where a recorded answer came from, readable by anyone who reads the packet, because a
--      reviewer cannot read the asker's suggestion and the answer must not hang on it. Its only writer is the RPC below.
--   2. app.advance_draft_scope: the sent packet and the sections Aurora may draft for a recipient, checked before any
--      model call or metering.
--   3. app.record_drafted_advance_answer: records one accepted answer through private.record_advance_answer, whose
--      offering, cap, line and advance_answer_pending rules all hold, and tells the recipient side.
--   4. api_external.advance_submissions (latest 4714) appends recorded_by_producer.

-- 1. Sources ---------------------------------------------------------------------------------------------------------------

create type app.advance_answer_source_kind as enum ('Project Inbox', 'File');
comment on type app.advance_answer_source_kind is 'What an answer recorded from an Aurora draft was read from: mail in the project''s inbox, or a file the person chose. Labels come from the catalog keyed by this value.';

create table app.advance_answer_sources (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  advance_submission_id uuid not null unique references app.advance_submissions (id),
  source_kind app.advance_answer_source_kind not null,
  inbound_message_id uuid references app.inbound_messages (id) on delete set null,
  file_name text,
  source_excerpt text not null,
  constraint advance_answer_sources_source check (
    (source_kind = 'File' and file_name is not null and inbound_message_id is null)
    or (source_kind = 'Project Inbox' and file_name is null)),
  constraint advance_answer_sources_file_name_length check (file_name is null or char_length(btrim(file_name)) between 1 and 300),
  constraint advance_answer_sources_excerpt_length check (char_length(btrim(source_excerpt)) between 1 and 2000)
);

create index advance_answer_sources_inbound_message_id_idx on app.advance_answer_sources (inbound_message_id);

call private.install_domain_table('app.advance_answer_sources', 'app.advance_submissions', 'advance_submission_id',
  array['app.inbound_messages', 'inbound_message_id']);
call private.describe('app.advance_answer_sources', 'Where an advance answer recorded from an accepted Aurora draft came from (B15, ADR 0154 D1), for the reviewer and the recipient. created_by is the person who accepted it, who is also the answer''s submitter. Written only by app.record_drafted_advance_answer. deleted_at is never set and the table has no Trash entry, like an answer''s lines (4711).', array[
  'advance_submission_id', 'Answer recorded.',
  'source_kind', 'Project Inbox or File.',
  'inbound_message_id', 'Project inbox message read, when it was one; null once that mail is purged at 2 years.',
  'file_name', 'Name of the file read, when it was a file.',
  'source_excerpt', 'The words the answer was read from, a snapshot of the suggestion''s excerpt, so retention of the answer does not hang on the suggestion.'
]);
call private.install_policies('app.advance_answer_sources',
  $$advance_submission_id in (select a.id from app.advance_submissions a join app.advance_sections s on s.id = a.advance_section_id
    join app.advance_packets p on p.id = s.advance_packet_id where p.project_id in (select private.project_ids_with('advancing.packet.read')))$$);
call private.install_audit_trail('app.advance_answer_sources');
call private.install_default_retention('app.advance_answer_sources');

-- 2. What Aurora may draft ---------------------------------------------------------------------------------------------------

create or replace function private.advance_section_draftable(p_recipient app.advance_recipients, p_section app.advance_sections, p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_section.deleted_at is null
    and p_section.advance_packet_id = p_recipient.advance_packet_id
    and not p_section.per_person
    and (p_section.section_kind in ('Text', 'Schedule Window')
      or (p_section.section_kind in ('Item Request', 'Credential Request')
        and p_recipient.engagement_id is not null
        and private.can_on_project(p_project_id, 'advancing.packet.write')));
$$;

comment on function private.advance_section_draftable(app.advance_recipients, app.advance_sections, uuid) is 'True when Aurora may draft an answer to this section for this recipient (B15, ADR 0154 D1): a live, not per-person section of the recipient''s packet, of kind Text or Schedule Window, or Item Request or Credential Request for a recipient with an engagement and a caller who also holds advancing.packet.write, since those lines become requests for the party (app.request_allocation, 4693). Whether it is still open is asked separately.';

create or replace function private.advance_section_open_for(p_recipient_id uuid, p_section_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from (
      select x.review_outcome from app.advance_submissions x
      where x.advance_section_id = p_section_id and x.advance_recipient_id = p_recipient_id and x.deleted_at is null
      order by x.submitted_at desc, x.id desc limit 1) a
    where a.review_outcome is null or a.review_outcome = 'Accepted');
$$;

comment on function private.advance_section_open_for(uuid, uuid) is 'True when the recipient has no answer on the section yet, or their latest answer was Returned, as R9''s advance_answer_pending reads it.';

create or replace function app.advance_draft_scope(p_recipient_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_recipient app.advance_recipients;
  v_packet app.advance_packets;
  v_project app.projects;
  v_sections jsonb;
begin
  select r.* into v_recipient from app.advance_recipients r where r.id = p_recipient_id and r.deleted_at is null;
  select p.* into v_packet from app.advance_packets p where p.id = v_recipient.advance_packet_id and p.deleted_at is null;
  select pr.* into v_project from app.projects pr where pr.id = v_packet.project_id;
  if v_recipient.id is null or v_packet.id is null or not private.is_member(v_packet.org_id)
     or not private.can_on_project(v_packet.project_id, 'advancing.submission.review') then
    raise exception using errcode = '42501', message = 'drafting advance answers needs advancing.submission.review on the packet''s project in your org';
  end if;
  if v_packet.sent_at is null then
    perform private.refuse('advance_packet_unsent', 'A packet takes answers once it is sent.');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'title', s.title, 'prompt', s.prompt, 'kind', s.section_kind, 'window_kind', s.window_kind, 'max_lines', s.max_lines,
      'choices', coalesce((
        select jsonb_agg(jsonb_build_object('id', c.id, 'name', coalesce(ac.name, k.name)) order by coalesce(ac.name, k.name), c.id)
        from app.advance_section_choices c
        left join app.asset_classes ac on ac.id = c.asset_class_id
        left join app.credential_categories k on k.id = c.credential_category_id
        where c.advance_section_id = s.id and c.deleted_at is null), '[]'::jsonb))
      order by s.position), '[]'::jsonb)
  into v_sections
  from app.advance_sections s
  where private.advance_section_draftable(v_recipient, s, v_packet.project_id)
    and private.advance_section_open_for(v_recipient.id, s.id);
  if jsonb_array_length(v_sections) = 0 then
    perform private.refuse('aurora_advance_no_open_sections', 'This recipient has no open section Aurora can draft.');
  end if;
  return jsonb_build_object('recipient_id', v_recipient.id, 'packet_id', v_packet.id, 'project_id', v_packet.project_id,
    'time_zone', v_project.time_zone, 'sections', v_sections);
end;
$$;

comment on function app.advance_draft_scope(uuid) is 'What Aurora may draft for a recipient of a sent packet (B15, ADR 0154 D1), asked before any model call or metering. Needs advancing.submission.review on the packet''s project and membership in its org, otherwise 42501; an unsent packet refuses advance_packet_unsent. Returns the recipient, packet, project, the project''s time zone, and the sections private.advance_section_draftable allows and that are still open, each with id, title, prompt, kind, window_kind, max_lines and its choices (app.advance_section_choices id and name). With none it refuses aurora_advance_no_open_sections. Holds no roster, profile, project fact or other answer.';

-- 3. Recording an accepted draft ---------------------------------------------------------------------------------------------

create or replace function private.proposed_field(p_suggestion_id uuid, p_path text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select f.proposed_value from app.ai_suggestion_fields f
  where f.suggestion_id = p_suggestion_id and f.field_path = p_path and f.refusal is null and f.deleted_at is null;
$$;

comment on function private.proposed_field(uuid, text) is 'A suggestion field''s proposed value, or null when it is NO_ANSWER or absent.';

create or replace function private.normalize_whitespace(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'));
$$;

comment on function private.normalize_whitespace(text) is 'A text with each run of white space as one space and none at its ends.';

create or replace function app.record_drafted_advance_answer(p_suggestion_id uuid, p_values jsonb default '{}')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_suggestion app.ai_suggestions;
  v_request app.ai_requests;
  v_recipient app.advance_recipients;
  v_packet app.advance_packets;
  v_section app.advance_sections;
  v_values jsonb := coalesce(p_values, '{}'::jsonb);
  v_key text;
  v_kind text;
  v_excerpt text;
  v_message_id uuid;
  v_file text;
  v_text text;
  v_lines jsonb;
  v_line jsonb;
  v_out jsonb := '[]';
  v_row jsonb;
  v_choice app.advance_section_choices;
  v_quantity numeric;
  v_note text;
  v_submission uuid;
  v_person uuid;
  v_project_name text;
begin
  select * into v_suggestion from app.ai_suggestions s where s.id = p_suggestion_id and s.deleted_at is null;
  if v_suggestion.id is null or not private.ai_request_is_mine(v_suggestion.request_id) then
    raise exception using errcode = '42501', message = 'only the person who asked records a drafted answer';
  end if;
  select * into v_request from app.ai_requests r where r.id = v_suggestion.request_id;
  -- The request and the suggestion's target are the proof; a suggestion's fields are not (ADR 0154).
  if v_request.feature <> 'drafting' or v_request.outcome <> 'Answered' or v_request.subject_table is distinct from 'app.advance_recipients'
     or v_suggestion.operation_id <> 'advanceAnswers.record' or v_suggestion.target_id is null then
    perform private.refuse('aurora_draft_request_invalid', 'This suggestion is not a drafted advance answer.');
  end if;
  if v_suggestion.suggestion_state <> 'Proposed' then
    perform private.refuse('ai_suggestion_transition_not_allowed', 'This answer was already decided.');
  end if;
  if v_suggestion.expires_at <= now() then
    perform private.refuse('ai_suggestion_expired', 'This suggestion has expired. Ask again to get a fresh one.');
  end if;

  select r.* into v_recipient from app.advance_recipients r where r.id = v_request.subject_id and r.deleted_at is null;
  select p.* into v_packet from app.advance_packets p where p.id = v_recipient.advance_packet_id and p.deleted_at is null;
  if v_recipient.id is null or v_packet.id is null or v_packet.org_id is distinct from v_request.org_id
     or not private.is_member(v_packet.org_id)
     or not private.can_on_project(v_packet.project_id, 'advancing.submission.review') then
    raise exception using errcode = '42501', message = 'recording an answer needs advancing.submission.review on the packet''s project in your org';
  end if;
  select s.* into v_section from app.advance_sections s where s.id = v_suggestion.target_id;
  if v_section.id is null or not private.advance_section_draftable(v_recipient, v_section, v_packet.project_id) then
    -- A kind this caller may not record with packet.write missing reads as a capability refusal, as app.request_allocation does.
    if v_section.section_kind in ('Item Request', 'Credential Request') and v_recipient.engagement_id is not null
       and not v_section.per_person and not private.can_on_project(v_packet.project_id, 'advancing.packet.write') then
      raise exception using errcode = '42501', message = 'recording items or credentials for a party needs advancing.packet.write on the packet''s project';
    end if;
    perform private.refuse('aurora_advance_section_not_allowed', 'Aurora does not record an answer to this section.');
  end if;

  for v_key in select jsonb_object_keys(v_values) loop
    if not (v_key = any (array['text', 'note', 'lines'])) then
      perform private.refuse('advance_line_kind', format('An answer cannot set %s.', v_key));
    end if;
  end loop;

  -- The source, read again. Stored excerpts are redacted, so mail is compared through the same redaction.
  v_kind := private.proposed_field(v_suggestion.id, 'source_kind') #>> '{}';
  select nullif(btrim(f.source_excerpt), '') into v_excerpt from app.ai_suggestion_fields f
  where f.suggestion_id = v_suggestion.id and f.field_path = 'source_kind' and f.deleted_at is null;
  if v_excerpt is null then
    perform private.refuse('aurora_advance_source_unverified', 'This answer does not show the words it was read from.');
  end if;
  if v_kind = 'Project Inbox' then
    v_message_id := nullif(private.proposed_field(v_suggestion.id, 'inbound_message_id') #>> '{}', '')::uuid;
    if not exists (
         select 1 from app.inbound_messages m join app.inbound_addresses a on a.id = m.inbound_address_id
         where m.id = v_message_id and m.deleted_at is null and m.purpose = 'Project Inbox'
           and m.inbound_status in ('Verified', 'Filed') and m.discarded_at is null and a.project_id = v_packet.project_id
           and private.can_on_project(a.project_id, 'knowledge.document.write')
           and strpos(private.normalize_whitespace(private.ai_redact(m.body_text)), private.normalize_whitespace(v_excerpt)) > 0) then
      perform private.refuse('aurora_advance_source_unverified', 'This answer was not read from verified mail in this project''s inbox that you can read.');
    end if;
  elsif v_kind = 'File' then
    v_file := btrim(coalesce(private.proposed_field(v_suggestion.id, 'file_name') #>> '{}', ''));
    if char_length(v_file) not between 1 and 300 then
      perform private.refuse('aurora_advance_source_unverified', 'This answer does not name the file it was read from.');
    end if;
  else
    perform private.refuse('aurora_advance_source_unverified', 'This answer does not name its source.');
  end if;

  -- Values correct the proposal key by key. A Text answer has no note (4711's guard), and a window line has none either.
  v_text := coalesce(v_values ->> 'text', private.proposed_field(v_suggestion.id, 'text') #>> '{}');
  v_note := case when v_section.section_kind in ('Item Request', 'Credential Request')
                 then coalesce(v_values ->> 'note', private.proposed_field(v_suggestion.id, 'note') #>> '{}') end;
  v_lines := case when v_values ? 'lines' then v_values -> 'lines' else private.proposed_field(v_suggestion.id, 'lines') end;
  if v_section.section_kind = 'Text' then
    v_lines := '[]'::jsonb;
    v_note := null;
  elsif jsonb_typeof(v_lines) is distinct from 'array' then
    perform private.refuse('advance_line_kind', 'This section takes lines.');
  else
    for v_line in select value from jsonb_array_elements(v_lines) loop
      if jsonb_typeof(v_line) <> 'object' then
        perform private.refuse('advance_line_kind', 'Each line is an object.');
      end if;
      for v_key in select jsonb_object_keys(v_line) loop
        if not (v_key = any (array['choice_id', 'quantity', 'needed_window_start', 'needed_window_end', 'window_zone', 'note'])) then
          perform private.refuse('advance_line_kind', format('A line cannot set %s.', v_key));
        end if;
      end loop;
      v_row := v_line - 'choice_id';
      if v_section.section_kind = 'Schedule Window' then
        if v_line ? 'choice_id' or v_line ? 'quantity' then
          perform private.refuse('advance_line_kind', 'A schedule window line gives a start, an end and a time zone only.');
        end if;
        v_row := v_row - 'note';
      else
        -- The choice is resolved here, through the section's own choices, never taken from the model.
        select c.* into v_choice from app.advance_section_choices c
        where c.id = nullif(v_line ->> 'choice_id', '')::uuid and c.advance_section_id = v_section.id and c.deleted_at is null;
        if v_choice.id is null then
          perform private.refuse('advance_line_kind', 'A line names one of the section''s choices.');
        end if;
        v_row := v_row || jsonb_strip_nulls(jsonb_build_object('asset_class_id', v_choice.asset_class_id,
          'credential_category_id', v_choice.credential_category_id));
        v_quantity := (v_line ->> 'quantity')::numeric;
        if v_quantity is null or v_quantity <> trunc(v_quantity) or v_quantity not between 1 and 10000 then
          perform private.refuse('advance_line_kind', 'A quantity runs from 1 to 10,000.');
        end if;
        if char_length(btrim(coalesce(v_line ->> 'note', ''))) > 500 then
          perform private.refuse('advance_line_kind', 'A line note runs at most 500 characters.');
        end if;
      end if;
      v_out := v_out || jsonb_build_array(v_row);
    end loop;
    v_lines := v_out;
  end if;

  v_submission := private.record_advance_answer(v_recipient.id, v_section.id, v_text, v_note, v_lines, '{}', null);

  insert into app.advance_answer_sources (advance_submission_id, source_kind, inbound_message_id, file_name, source_excerpt)
  values (v_submission, v_kind::app.advance_answer_source_kind, v_message_id, v_file, left(v_excerpt, 2000));

  perform app.transition_ai_suggestion(v_suggestion.id, 'Proposed', 'Confirmed', 'Accepted as a drafted advance answer.');
  perform app.transition_ai_suggestion(v_suggestion.id, 'Confirmed', 'Applied', 'Recorded by app.record_drafted_advance_answer.', v_submission);

  -- The recipient side is told, since advance_answer_pending now holds them back from answering this section.
  select pr.name into v_project_name from app.projects pr where pr.id = v_packet.project_id;
  for v_person in
    select v_recipient.person_id where v_recipient.person_id is not null
    union
    select m.person_id
    from app.counterparties c
    join app.account_memberships m on m.org_id = c.organization_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    join app.account_membership_roles r on r.account_membership_id = m.id and r.deleted_at is null
      and r.account_role in ('Account Owner', 'Account Admin', 'Account Member')
    where c.id = v_recipient.counterparty_id
  loop
    if v_person is distinct from v_me then
      perform private.notify(v_packet.org_id, v_person, 'advance_answer.recorded', 'advance_submissions', v_submission, v_packet.project_id,
        jsonb_build_object('sectionTitle', v_section.title, 'projectName', v_project_name)
          || case when v_recipient.engagement_id is not null
               then jsonb_build_object('gatewayPath', replace(private.roster_crew_path(v_recipient.engagement_id), '/crew', '/advance'))
               else '{}'::jsonb end);
    end if;
  end loop;

  return v_submission;
end;
$$;

comment on function app.record_drafted_advance_answer(uuid, jsonb) is 'Records one advance answer drafted by Aurora, for the person who accepts it (B15, ADR 0154 D1). The suggestion is the caller''s own (42501), an advanceAnswers.record suggestion of an Answered drafting request whose subject is the recipient, target_id the section, Proposed (ai_suggestion_transition_not_allowed) and unexpired (ai_suggestion_expired). The caller holds advancing.submission.review on the packet''s project and is a member of its org (42501), plus advancing.packet.write for an Item Request or Credential Request (42501); the section must be private.advance_section_draftable, so Guest List, File, Crew Roster and per-person sections refuse aurora_advance_section_not_allowed. Project Inbox mail is read again: purpose Project Inbox, the packet''s project''s inbox, Verified or Filed, not discarded, knowledge.document.write on the project, and the excerpt found in private.ai_redact(body_text) after whitespace normalization; any failure refuses aurora_advance_source_unverified. p_values may correct text, note (Item and Credential only) and lines; a line takes exactly choice_id, quantity, needed_window_start, needed_window_end, window_zone and note, the choice is resolved through the section''s own choices (advance_line_kind), a quantity runs 1 to 10000 and a note at most 500 characters. Writes through private.record_advance_answer, so its offering, cap, line and advance_answer_pending rules hold and the caller is the submitter (sod_advance_submitter). Adds the app.advance_answer_sources row, moves the suggestion Proposed, Confirmed, Applied with the answer, and notifies the recipient person or the account''s Owner, Admin and Member people with advance_answer.recorded, excluding the actor. Returns the answer id. Calls no model and meters nothing.';

-- 4. What Gateway reads ------------------------------------------------------------------------------------------------------
-- From 4714 (no later definition on this stack), with recorded_by_producer appended.

create or replace view api_external.advance_submissions as
select a.id, a.advance_section_id, a.advance_recipient_id, a.body, a.submitted_at, a.reviewed_at, a.review_outcome, a.return_reason,
  a.note as answer_note,
  exists (select 1 from app.advance_answer_sources x where x.advance_submission_id = a.id) as recorded_by_producer
from app.advance_submissions a
where a.deleted_at is null and a.advance_recipient_id in (select x.id from api_external.my_advance_recipients x);

call private.describe('api_external.advance_submissions', 'Answers given for the caller''s advance recipients, with the review outcome and any reason an answer was returned. Who reviewed never appears.', array[
  'id', 'Answer.', 'advance_section_id', 'Section.', 'advance_recipient_id', 'Recipient.', 'body', 'Answer as rich text, or the summary of a typed answer.',
  'submitted_at', 'When given.', 'reviewed_at', 'When reviewed.', 'review_outcome', 'Accepted or Returned.', 'return_reason', 'Why it was returned.',
  'answer_note', 'The recipient''s own note on a typed answer (R9).',
  'recorded_by_producer', 'True when the producer recorded the answer for the party from an Aurora draft (B15).']);

-- Grants are kept by create or replace; restated so this file reads whole.
revoke all on api_external.advance_submissions from public, anon;
grant select on api_external.advance_submissions to authenticated, service_role;

-- receiveInbound strips only replies now, so a forward to a project inbox keeps the message it forwards (ADR 0154).
comment on column app.inbound_messages.body_text is 'Plain-text body: a reply without its quoted text, project inbox mail in full, clipped as before.';

-- Privileges -----------------------------------------------------------------------------------------------------------------

revoke all on function private.advance_section_draftable(app.advance_recipients, app.advance_sections, uuid) from public, anon, authenticated;
revoke all on function private.advance_section_open_for(uuid, uuid) from public, anon, authenticated;
revoke all on function private.proposed_field(uuid, text) from public, anon, authenticated;
revoke all on function private.normalize_whitespace(text) from public, anon, authenticated;
revoke all on function app.advance_draft_scope(uuid) from public, anon;
revoke all on function app.record_drafted_advance_answer(uuid, jsonb) from public, anon;
grant execute on function app.advance_draft_scope(uuid) to authenticated, service_role;
grant execute on function app.record_drafted_advance_answer(uuid, jsonb) to authenticated, service_role;

-- ADR 0110: the sources carry no title and no deleted row, so the sync adds nothing; it runs so Trash is decided here.
select private.sync_trash_tables();
