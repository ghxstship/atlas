-- 3044_advance_answer_drafts.sql
-- B15 advance answers drafted with Aurora (RRR-239, parity gap G-173; ADR 0154 amends ADR 0100). A coordinator who
-- reviews advance answers can have Aurora read a project inbox message or a document the party sent (a reply, a tour
-- book, a rider) into answers for the recipient's open sections, and record each answer they accept on the party's
-- behalf. The answer goes through R9's single writer, so lines, allocations, offerings and caps behave as for the
-- party; the recorder becomes its submitter, so someone else reviews it; and Gateway labels it.
--
--   1. app.advance_answer_drafts (append-only): the provenance of an answer recorded from a confirmed Aurora draft,
--      the suggestion it came from and its source, a project inbox message or a file name. Read with
--      advancing.packet.read on the packet's project; written only inside aurora_batch_apply.
--   2. app.draftable_advance_sections: the sections Aurora may draft for a recipient of a sent packet, with their
--      choices and the engagement's roster (ids and names), for advancing.submission.review holders.
--   3. app.apply_drafted_advance_answer: records one accepted draft through private.record_advance_answer, writes its
--      provenance and marks the suggestion Applied with the answer.
--   4. api_external.advance_submissions (latest 2714) appends recorded_by_producer and recorded_from_message.
-- Nothing here changes private.record_advance_answer (latest 2716) or the guards of 2711.

-- 1. Provenance ------------------------------------------------------------------------------------------------------------

create table app.advance_answer_drafts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  advance_submission_id uuid not null references app.advance_submissions (id),
  ai_suggestion_id uuid not null references app.ai_suggestions (id),
  inbound_message_id uuid references app.inbound_messages (id),
  source_file_name text,
  constraint advance_answer_drafts_one_source check (num_nonnulls(inbound_message_id, source_file_name) = 1),
  constraint advance_answer_drafts_file_name_length check (source_file_name is null or char_length(btrim(source_file_name)) between 1 and 300)
);

create unique index advance_answer_drafts_submission_key on app.advance_answer_drafts (advance_submission_id);
create index advance_answer_drafts_ai_suggestion_id_idx on app.advance_answer_drafts (ai_suggestion_id);
create index advance_answer_drafts_inbound_message_id_idx on app.advance_answer_drafts (inbound_message_id);

call private.install_domain_table('app.advance_answer_drafts', 'app.advance_submissions', 'advance_submission_id',
  array['app.ai_suggestions', 'ai_suggestion_id', 'app.inbound_messages', 'inbound_message_id'], true);
call private.describe('app.advance_answer_drafts', 'Provenance of an advance answer a coordinator recorded on the party''s behalf from a confirmed Aurora draft (B15, ADR 0154): the Aurora suggestion, and the source read, a project inbox message or a file. created_by is the recorder, who is also the answer''s submitter and so never its reviewer. Written only by app.apply_drafted_advance_answer; append-only.', array[
  'advance_submission_id', 'Answer recorded.',
  'ai_suggestion_id', 'Aurora suggestion the answer was drafted in; its request names the recipient.',
  'inbound_message_id', 'Project inbox message the draft was read from, when it was one.',
  'source_file_name', 'Name of the file the draft was read from, when it was a file.'
]);
call private.install_policies('app.advance_answer_drafts',
  $$advance_submission_id in (select a.id from app.advance_submissions a join app.advance_sections s on s.id = a.advance_section_id
    join app.advance_packets p on p.id = s.advance_packet_id where p.project_id in (select private.project_ids_with('advancing.packet.read')))$$);
call private.install_default_retention('app.advance_answer_drafts');

create or replace function private.guard_advance_answer_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.in_trusted_operation('aurora_batch_apply') then
    perform private.refuse('ai_suggestion_batch_apply', 'An answer drafted with Aurora is recorded from the Aurora preview.');
  end if;
  return new;
end;
$$;

comment on function private.guard_advance_answer_draft() is 'Before insert on app.advance_answer_drafts: only app.apply_drafted_advance_answer, inside aurora_batch_apply, records provenance.';

create trigger t40_guard_advance_answer_draft before insert on app.advance_answer_drafts
  for each row execute function private.guard_advance_answer_draft();

-- 2. What Aurora may draft -------------------------------------------------------------------------------------------------

-- A section Aurora may draft for a recipient: live, of a drafted kind, its latest answer absent or Returned, and for
-- an item or credential request, a recipient answering under an engagement.
create or replace function private.advance_section_draftable(p_recipient_id uuid, p_section_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.advance_recipients r
    join app.advance_sections s on s.advance_packet_id = r.advance_packet_id
    where r.id = p_recipient_id and s.id = p_section_id and r.deleted_at is null and s.deleted_at is null
      and s.section_kind in ('Text', 'Schedule Window', 'Item Request', 'Credential Request')
      and (s.section_kind in ('Text', 'Schedule Window') or r.engagement_id is not null)
      and not exists (
        select 1 from (
          select x.review_outcome from app.advance_submissions x
          where x.advance_section_id = s.id and x.advance_recipient_id = r.id and x.deleted_at is null
          order by x.submitted_at desc, x.id desc limit 1) a
        where a.review_outcome is null or a.review_outcome = 'Accepted'));
$$;

comment on function private.advance_section_draftable(uuid, uuid) is 'True when Aurora may draft an answer to the section for the recipient (B15): a live Text, Schedule Window, Item Request or Credential Request section of the recipient''s packet whose latest answer is absent or Returned; Item Request and Credential Request only for a recipient with an engagement. Crew Roster, Guest List and File are never drafted.';

create or replace function app.draftable_advance_sections(p_recipient_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_recipient app.advance_recipients;
  v_packet app.advance_packets;
  v_zone text;
  v_sections jsonb;
  v_roster jsonb;
begin
  select r.* into v_recipient from app.advance_recipients r where r.id = p_recipient_id and r.deleted_at is null;
  select p.* into v_packet from app.advance_packets p where p.id = v_recipient.advance_packet_id and p.deleted_at is null;
  if v_recipient.id is null or v_packet.id is null
     or not private.can_on_project(v_packet.project_id, 'advancing.submission.review') then
    raise exception using errcode = '42501', message = 'drafting advance answers needs advancing.submission.review on the packet''s project';
  end if;
  if v_packet.sent_at is null then
    perform private.refuse('advance_packet_unsent', 'A packet takes answers once it is sent.');
  end if;
  select pr.time_zone into v_zone from app.projects pr where pr.id = v_packet.project_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'title', s.title, 'prompt', s.prompt, 'kind', s.section_kind, 'window_kind', s.window_kind,
      'max_lines', s.max_lines, 'per_person', s.per_person,
      'choices', coalesce((
        select jsonb_agg(case
            when c.asset_class_id is not null then jsonb_build_object('asset_class_id', ac.id, 'code', ac.element_id,
              'name', ac.name, 'offering', ac.offering)
            else jsonb_build_object('credential_category_id', k.id, 'name', k.name) end
          order by coalesce(ac.name, k.name), c.id)
        from app.advance_section_choices c
        left join app.asset_classes ac on ac.id = c.asset_class_id
        left join app.credential_categories k on k.id = c.credential_category_id
        where c.advance_section_id = s.id and c.deleted_at is null), '[]'::jsonb))
      order by s.position), '[]'::jsonb)
  into v_sections
  from app.advance_sections s
  where s.advance_packet_id = v_packet.id and private.advance_section_draftable(v_recipient.id, s.id);

  select coalesce(jsonb_agg(jsonb_build_object('id', rp.roster_entry_id, 'name', h.full_name) order by h.full_name, rp.roster_entry_id), '[]'::jsonb)
  into v_roster
  from private.roster_people rp
  join app.engagement_roster_entries re on re.id = rp.roster_entry_id
  join app.people h on h.id = rp.person_id
  where rp.engagement_id = v_recipient.engagement_id and re.deleted_at is null and re.entry_state <> 'Withdrawn';

  return jsonb_build_object('recipient_id', v_recipient.id, 'packet_id', v_packet.id, 'project_id', v_packet.project_id,
    'time_zone', v_zone, 'engagement_id', v_recipient.engagement_id, 'sections', v_sections, 'roster', v_roster);
end;
$$;

comment on function app.draftable_advance_sections(uuid) is 'What Aurora may draft for a recipient of a sent packet (B15): the sections of private.advance_section_draftable in position order, each with id, title, prompt, kind, window_kind, max_lines, per_person and its choices (asset_class_id with code, name and offering, or credential_category_id with name), and the live roster entries of the recipient''s engagement (id and name only), with the project''s zone. Needs advancing.submission.review on the packet''s project (42501 otherwise); an unsent packet refuses advance_packet_unsent.';

-- 3. Recording an accepted draft -------------------------------------------------------------------------------------------

create or replace function app.apply_drafted_advance_answer(p_suggestion_id uuid, p_values jsonb, p_source jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_suggestion app.ai_suggestions;
  v_request app.ai_requests;
  v_recipient app.advance_recipients;
  v_packet app.advance_packets;
  v_section app.advance_sections;
  v_values jsonb := coalesce(p_values, '{}'::jsonb);
  v_source jsonb := coalesce(p_source, '{}'::jsonb);
  v_message uuid;
  v_file text;
  v_key text;
  v_body jsonb;
  v_lines jsonb;
  v_note jsonb;
  v_submission uuid;
begin
  -- (a) The caller's own answered drafting request about an advance recipient, and a Proposed answer of it.
  select * into v_suggestion from app.ai_suggestions s where s.id = p_suggestion_id and s.deleted_at is null;
  select * into v_request from app.ai_requests r where r.id = v_suggestion.request_id and r.deleted_at is null;
  if v_suggestion.id is null or v_request.person_id is distinct from private.current_person_id() then
    raise exception using errcode = '42501', message = 'only the person who asked records a drafted answer';
  end if;
  if v_request.feature <> 'drafting' or v_request.outcome <> 'Answered' or v_request.subject_table is distinct from 'app.advance_recipients'
     or v_suggestion.operation_id <> 'aurora.applyAdvanceAnswer' or v_suggestion.target_id is null then
    perform private.refuse('aurora_draft_request_invalid', 'This suggestion is not a drafted advance answer.');
  end if;
  if v_suggestion.suggestion_state <> 'Proposed' or v_suggestion.expires_at <= now() then
    perform private.refuse('ai_suggestion_expired', 'This suggestion has expired. Ask again to get a fresh one.');
  end if;

  -- (b) A reviewer on the packet's project, a section still draftable, and a live engagement when one is linked.
  select r.* into v_recipient from app.advance_recipients r where r.id = v_request.subject_id and r.deleted_at is null;
  select p.* into v_packet from app.advance_packets p where p.id = v_recipient.advance_packet_id and p.deleted_at is null;
  if v_recipient.id is null or v_packet.id is null
     or not private.can_on_project(v_packet.project_id, 'advancing.submission.review') then
    raise exception using errcode = '42501', message = 'recording an answer needs advancing.submission.review on the packet''s project';
  end if;
  -- An answer still open on the section is left to R9's guard, so it refuses advance_answer_pending as for the party.
  select s.* into v_section from app.advance_sections s
  where s.id = v_suggestion.target_id and s.advance_packet_id = v_packet.id and s.deleted_at is null;
  if v_section.id is null or v_section.section_kind not in ('Text', 'Schedule Window', 'Item Request', 'Credential Request')
     or (v_section.section_kind in ('Item Request', 'Credential Request') and v_recipient.engagement_id is null)
     or (v_recipient.engagement_id is not null and not exists (
       select 1 from app.engagements e where e.id = v_recipient.engagement_id and e.deleted_at is null
         and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing'))) then
    perform private.refuse('advance_section_not_draftable', 'This section is answered already or no longer takes an answer from Aurora.');
  end if;

  -- (c) The source, checked again as the caller: a verified, live project inbox message of the packet's project the
  -- caller may read, or a file name.
  if jsonb_typeof(v_source) <> 'object' or (select count(*) from jsonb_object_keys(v_source)) <> 1 then
    perform private.refuse('aurora_draft_source_invalid', 'Name one source: a project inbox message or a file.');
  end if;
  if v_source ? 'inbound_message_id' then
    select m.id into v_message
    from app.inbound_messages m join app.inbound_addresses a on a.id = m.inbound_address_id
    where m.id = nullif(v_source ->> 'inbound_message_id', '')::uuid and m.deleted_at is null
      and m.purpose = 'Project Inbox' and m.dkim_verified and m.inbound_status <> 'Rejected' and m.discarded_at is null
      and a.project_id = v_packet.project_id
      and a.project_id in (select private.project_ids_with('knowledge.document.write'));
    if v_message is null then
      perform private.refuse('aurora_draft_source_invalid', 'Aurora drafts from a verified message in this project''s inbox that you can read.');
    end if;
  elsif v_source ? 'file_name' then
    v_file := btrim(coalesce(v_source ->> 'file_name', ''));
    if char_length(v_file) not between 1 and 300 then
      perform private.refuse('aurora_draft_source_invalid', 'A file name runs 1 to 300 characters.');
    end if;
  else
    perform private.refuse('aurora_draft_source_invalid', 'Name one source: a project inbox message or a file.');
  end if;

  -- (d) Values override the proposed body, lines and note key by key.
  if jsonb_typeof(v_values) <> 'object' then
    perform private.refuse('advance_line_kind', 'Give the answer''s values as an object.');
  end if;
  for v_key in select jsonb_object_keys(v_values) loop
    if not (v_key = any (array['body', 'lines', 'note'])) then
      perform private.refuse('advance_line_kind', format('An answer cannot set %s.', v_key));
    end if;
  end loop;
  v_body := case when v_values ? 'body' then v_values -> 'body' else private.intake_field(v_suggestion.id, 'body') end;
  v_lines := case when v_values ? 'lines' then v_values -> 'lines' else private.intake_field(v_suggestion.id, 'lines') end;
  v_note := case when v_values ? 'note' then v_values -> 'note' else private.intake_field(v_suggestion.id, 'note') end;

  -- (e) R9's single writer, then the provenance and the suggestion, inside aurora_batch_apply.
  perform private.begin_trusted_operation('aurora_batch_apply');
  v_submission := private.record_advance_answer(v_recipient.id, v_section.id,
    case when jsonb_typeof(v_body) = 'string' then v_body #>> '{}' end,
    case when v_section.section_kind <> 'Text' and jsonb_typeof(v_note) = 'string' then v_note #>> '{}' end,
    case when v_section.section_kind <> 'Text' and jsonb_typeof(v_lines) = 'array' then v_lines else '[]'::jsonb end,
    '{}', null);
  insert into app.advance_answer_drafts (advance_submission_id, ai_suggestion_id, inbound_message_id, source_file_name)
  values (v_submission, v_suggestion.id, v_message, v_file);
  perform app.transition_ai_suggestion(v_suggestion.id, 'Proposed', 'Confirmed', 'Accepted as a drafted advance answer.');
  perform app.transition_ai_suggestion(v_suggestion.id, 'Confirmed', 'Applied', 'Recorded by app.apply_drafted_advance_answer.', v_submission);
  perform private.end_trusted_operation('aurora_batch_apply');
  return v_submission;
end;
$$;

comment on function app.apply_drafted_advance_answer(uuid, jsonb, jsonb) is 'Records one advance answer drafted with Aurora on the recipient''s behalf (B15, ADR 0154). The suggestion is a Proposed, unexpired aurora.applyAdvanceAnswer suggestion (target_id the section) of the caller''s own Answered drafting request about an app.advance_recipients row (42501 for anyone else; aurora_draft_request_invalid, ai_suggestion_expired). The caller holds advancing.submission.review on the packet''s project (42501); the section is a live Text, Schedule Window, Item Request or Credential Request section of the packet (the last two only under an engagement) and a linked engagement is Onboarding to Closing (advance_section_not_draftable), while an answer still open on it is refused by R9''s guard as advance_answer_pending. p_source is {inbound_message_id}, a DKIM-verified, live, not Rejected or discarded Project Inbox message of the packet''s project in an inbox where the caller holds knowledge.document.write, or {file_name} of 1 to 300 characters (aurora_draft_source_invalid otherwise). p_values (body, lines in R9''s p_lines shape, note) override the proposed fields key by key. Writes through private.record_advance_answer, so advance_answer_pending, the line kinds and limits, roster entries, R7 offerings and caps hold, and the caller becomes the answer''s submitter (sod_advance_submitter keeps them from reviewing it). Inside aurora_batch_apply it adds the app.advance_answer_drafts row and moves the suggestion Proposed, Confirmed, Applied with the answer. Returns the answer id. Calls no model and meters nothing.';

-- 4. What Gateway reads ----------------------------------------------------------------------------------------------------
-- From 2714 (no later definition), with recorded_by_producer and recorded_from_message appended.

create or replace view api_external.advance_submissions as
select a.id, a.advance_section_id, a.advance_recipient_id, a.body, a.submitted_at, a.reviewed_at, a.review_outcome, a.return_reason,
  a.note as answer_note,
  exists (select 1 from app.advance_answer_drafts d where d.advance_submission_id = a.id) as recorded_by_producer,
  exists (select 1 from app.advance_answer_drafts d where d.advance_submission_id = a.id and d.inbound_message_id is not null)
    as recorded_from_message
from app.advance_submissions a
where a.deleted_at is null and a.advance_recipient_id in (select x.id from api_external.my_advance_recipients x);

call private.describe('api_external.advance_submissions', 'Answers given for the caller''s advance recipients, with the review outcome and any reason an answer was returned. Who reviewed never appears.', array[
  'id', 'Answer.', 'advance_section_id', 'Section.', 'advance_recipient_id', 'Recipient.', 'body', 'Answer as rich text, or the summary of a typed answer.',
  'submitted_at', 'When given.', 'reviewed_at', 'When reviewed.', 'review_outcome', 'Accepted or Returned.', 'return_reason', 'Why it was returned.',
  'answer_note', 'The recipient''s own note on a typed answer (R9).',
  'recorded_by_producer', 'True when the producer recorded the answer on the party''s behalf from an Aurora draft (B15).',
  'recorded_from_message', 'True when that draft was read from an email to the project''s inbox; false otherwise.']);

-- Grants are kept by create or replace; restated so this file reads whole.
revoke all on api_external.advance_submissions from public, anon;
grant select on api_external.advance_submissions to authenticated, service_role;

-- Privileges ---------------------------------------------------------------------------------------------------------------

revoke all on function private.guard_advance_answer_draft() from public, anon, authenticated;
revoke all on function private.advance_section_draftable(uuid, uuid) from public, anon, authenticated;
revoke all on function app.draftable_advance_sections(uuid) from public, anon;
revoke all on function app.apply_drafted_advance_answer(uuid, jsonb, jsonb) from public, anon;

grant execute on function app.draftable_advance_sections(uuid) to authenticated, service_role;
grant execute on function app.apply_drafted_advance_answer(uuid, jsonb, jsonb) to authenticated, service_role;

-- ADR 0110: the provenance carries no title, so the sync adds nothing; it runs so Trash is registered by the migrations.
select private.sync_trash_tables();
