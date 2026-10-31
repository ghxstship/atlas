-- 2711_advance_answer_lines.sql
-- R9 Typed advance answers (RRR-189, ADR 0100 and 0104; owner decisions 4, 7 and 8). A typed answer holds lines and
-- files beside its body, and its item and credential lines become R7 allocations that the answer's review decides.
--
--   1. app.advance_submission_lines (append-only): one line per window, item or credential, validated against the
--      section kind by t40_guard_advance_submission_line and written only inside record_advance_answer.
--   2. app.advance_submission_files (append-only): the party-uploads documents of a File answer.
--   3. app.advance_submissions.note, and private.advance_answer_summary: the locale-neutral body of a typed answer
--      (catalog codes, ISO 8601 instants in UTC with the zone, quantities, file titles; GUEST_LIST_CONFIRMED for a
--      Guest List). API v1 documents body as required, so it stays NOT NULL; both body and lines are immutable, so
--      the summary cannot drift (registered).
--   4. private.guard_advance_submission (from 0430): one open answer per section and recipient (R1's
--      advance_answer_pending), a Crew Roster section takes no answer (advance_section_derived), and a typed answer is
--      written only by private.record_advance_answer (advance_typed_answer_rpc). note is immutable like body.
--   5. private.record_advance_answer, the single writer of every kind, and app.submit_advance_answer for the signed-in
--      recipient. Item Request and Credential Request lines become Requested allocations through R7's
--      private.insert_allocation, so offerings, caps and the requester separation of 2693 hold. Token answers (R10)
--      pass p_token_id.
--   6. app.advance_allocations.advance_submission_line_id (R9 owns it) and t91_answer_review_allocations: accepting
--      the answer approves each linked Requested allocation through app.decide_allocation in its own subtransaction;
--      one that needs sources, has no capacity, goes beyond the allowance or names a person not yet accepted stays
--      Requested for the Allocations queue and the review still commits. Returning the answer declines them.
--   7. app.dock_slots.advance_submission_line_id and app.book_dock_slot_from_answer: an Accepted Load In or Load Out
--      window becomes a dock slot of the recipient's engagement.

-- 1. Lines -----------------------------------------------------------------------------------------------------------

create table app.advance_submission_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  advance_submission_id uuid not null references app.advance_submissions (id),
  line_number smallint not null,
  asset_class_id uuid references app.asset_classes (id),
  credential_category_id uuid references app.credential_categories (id),
  roster_entry_id uuid references app.engagement_roster_entries (id),
  quantity integer,
  needed_window tstzrange,
  window_zone text,
  note text,
  constraint advance_submission_lines_number check (line_number between 1 and 50),
  constraint advance_submission_lines_quantity check (quantity is null or quantity between 1 and 10000),
  constraint advance_submission_lines_window check (needed_window is null
    or (not isempty(needed_window) and not lower_inf(needed_window) and not upper_inf(needed_window))),
  constraint advance_submission_lines_window_zone check ((needed_window is null) = (window_zone is null)),
  constraint advance_submission_lines_one_target check (num_nonnulls(asset_class_id, credential_category_id) <= 1),
  constraint advance_submission_lines_note_length check (note is null or char_length(btrim(note)) between 1 and 500)
);
create unique index advance_submission_lines_number_key on app.advance_submission_lines (advance_submission_id, line_number);
create index advance_submission_lines_asset_class_id_idx on app.advance_submission_lines (asset_class_id);
create index advance_submission_lines_credential_category_id_idx on app.advance_submission_lines (credential_category_id);
create index advance_submission_lines_roster_entry_id_idx on app.advance_submission_lines (roster_entry_id);

call private.install_domain_table('app.advance_submission_lines', 'app.advance_submissions', 'advance_submission_id',
  array['app.asset_classes', 'asset_class_id', 'app.credential_categories', 'credential_category_id',
        'app.engagement_roster_entries', 'roster_entry_id'], true);
call private.install_policies('app.advance_submission_lines',
  $$advance_submission_id in (select a.id from app.advance_submissions a join app.advance_sections s on s.id = a.advance_section_id
    join app.advance_packets p on p.id = s.advance_packet_id where p.project_id in (select private.project_ids_with('advancing.packet.read')))$$);
call private.describe('app.advance_submission_lines', 'The lines of a typed advance answer (R9): a window of a Schedule Window section, or an asset class or credential category with a quantity, optionally for one person on the engagement''s roster and for a window. Written only by private.record_advance_answer; append-only.', array[
  'advance_submission_id', 'Answer the line belongs to.',
  'line_number', 'Order in the answer, 1 to 50.',
  'asset_class_id', 'Asset class asked for on an Item Request line; one of the section''s choices.',
  'credential_category_id', 'Credential category asked for on a Credential Request line; one of the section''s choices.',
  'roster_entry_id', 'Person on the engagement''s roster the line is for; NULL for the party''s pool.',
  'quantity', 'How many, 1 to 10000; 1 when a credential line names a person. NULL on a window line.',
  'needed_window', 'When it is needed, or the window a Schedule Window line proposes; bounded.',
  'window_zone', 'IANA time zone of the window.',
  'note', 'Note on the line, 1 to 500 characters.'
]);
call private.install_default_retention('app.advance_submission_lines');

-- 2. Files -----------------------------------------------------------------------------------------------------------

create table app.advance_submission_files (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  advance_submission_id uuid not null references app.advance_submissions (id),
  document_id uuid not null references app.documents (id),
  position smallint not null,
  constraint advance_submission_files_position check (position between 1 and 10)
);
create unique index advance_submission_files_document_key on app.advance_submission_files (document_id);
create unique index advance_submission_files_position_key on app.advance_submission_files (advance_submission_id, position);

call private.install_domain_table('app.advance_submission_files', 'app.advance_submissions', 'advance_submission_id',
  array['app.documents', 'document_id'], true);
call private.install_policies('app.advance_submission_files',
  $$advance_submission_id in (select a.id from app.advance_submissions a join app.advance_sections s on s.id = a.advance_section_id
    join app.advance_packets p on p.id = s.advance_packet_id where p.project_id in (select private.project_ids_with('advancing.packet.read')))$$);
call private.describe('app.advance_submission_files', 'Files of a File answer (R9): documents registered from the party-uploads bucket under the recipient and section, each attached to one answer. Written only by private.record_advance_answer; append-only.', array[
  'advance_submission_id', 'Answer the file belongs to.',
  'document_id', 'Document of the uploaded file; attached once.',
  'position', 'Order in the answer, 1 to 10.'
]);
call private.install_default_retention('app.advance_submission_files');

-- 3. The note and the summary body -------------------------------------------------------------------------------------

alter table app.advance_submissions add column note text,
  add constraint advance_submissions_note_length check (note is null or char_length(btrim(note)) between 1 and 2000);
comment on column app.advance_submissions.note is 'The recipient''s note on a typed answer, 1 to 2000 characters (R9); NULL on a Text answer, whose body is the answer.';

create or replace function private.advance_answer_summary(p_kind app.advance_section_kind, p_lines jsonb, p_titles text[])
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_kind = 'Guest List' then 'GUEST_LIST_CONFIRMED'
    when p_kind = 'File' then 'FILES ' || array_to_string(p_titles, ' | ')
    else (
      select string_agg(concat_ws(' ',
          upper(replace(p_kind::text, ' ', '_')),
          nullif(l ->> 'label', ''),
          case when l ? 'quantity' and l ->> 'quantity' is not null then 'x' || (l ->> 'quantity') end,
          case when l ->> 'roster_entry_id' is not null then 'ENTRY ' || (l ->> 'roster_entry_id') end,
          case when l ->> 'from' is not null then (l ->> 'from') || '/' || (l ->> 'to') || ' ' || (l ->> 'zone') end),
        E'\n' order by o)
      from jsonb_array_elements(p_lines) with ordinality x (l, o))
  end;
$$;
comment on function private.advance_answer_summary(app.advance_section_kind, jsonb, text[]) is 'The body of a typed advance answer (R9), locale-neutral: GUEST_LIST_CONFIRMED; FILES and the file titles; or one row per line with the kind code, the catalog code or category name (label), xQUANTITY, ENTRY and the roster entry, and the window as ISO 8601 instants in UTC with its IANA zone. p_lines holds {label, quantity, roster_entry_id, from, to, zone}.';
revoke all on function private.advance_answer_summary(app.advance_section_kind, jsonb, text[]) from public, anon, authenticated;

-- 4. Answers, from 0430 --------------------------------------------------------------------------------------------------

create or replace function private.guard_advance_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_packet uuid;
  v_sent timestamptz;
  v_kind app.advance_section_kind;
  v_submitter uuid;
  v_reviewer uuid;
begin
  if tg_op = 'INSERT' then
    select p.id, p.sent_at, s.section_kind into v_packet, v_sent, v_kind
    from app.advance_sections s join app.advance_packets p on p.id = s.advance_packet_id
    where s.id = new.advance_section_id and s.deleted_at is null and p.deleted_at is null;
    if v_packet is null then
      perform private.refuse('advance_section_open', 'Answers go to a live section of a live packet.');
    end if;
    if v_sent is null then
      perform private.refuse('advance_packet_unsent', 'A packet takes answers once it is sent.');
    end if;
    if not exists (select 1 from app.advance_recipients r
                   where r.id = new.advance_recipient_id and r.advance_packet_id = v_packet and r.deleted_at is null) then
      perform private.refuse('advance_recipient_packet', 'Only a recipient of the same packet answers its sections.');
    end if;
    if new.advance_recipient_token_id is not null then
      if not private.in_trusted_operation('submit_advance') or not exists (
        select 1 from app.advance_recipient_tokens t
        where t.id = new.advance_recipient_token_id and t.advance_recipient_id = new.advance_recipient_id) then
        perform private.refuse('advance_token_submission', 'Token answers arrive only through api_public.submit_advance for the token''s own recipient.');
      end if;
    end if;
    if new.reviewed_at is not null or new.reviewed_by is not null or new.review_outcome is not null or new.return_reason is not null then
      perform private.refuse('advance_submission_unreviewed', 'An answer arrives unreviewed.');
    end if;
    -- R9: a Crew Roster section is read from the roster, and a typed answer comes only from its one writer.
    if v_kind = 'Crew Roster' then
      perform private.refuse('advance_section_derived', 'The crew roster section is read from the engagement''s roster and takes no answer.');
    end if;
    if v_kind <> 'Text' and not private.in_trusted_operation('record_advance_answer') then
      perform private.refuse('advance_typed_answer_rpc', 'A typed answer is recorded with app.submit_advance_answer.');
    end if;
    if v_kind = 'Text' and new.note is not null then
      perform private.refuse('advance_typed_answer_rpc', 'A text answer has no separate note.');
    end if;
    -- R9: one answer at a time, as R1's RPCs refuse it (2604), now for every writer.
    if exists (
        select 1 from (
          select x.review_outcome from app.advance_submissions x
          where x.advance_section_id = new.advance_section_id and x.advance_recipient_id = new.advance_recipient_id
            and x.deleted_at is null
          order by x.submitted_at desc, x.id desc limit 1) a
        where a.review_outcome is null or a.review_outcome = 'Accepted') then
      perform private.refuse('advance_answer_pending', 'This section is answered; answer again only after it is returned.');
    end if;
    new.submitted_at := now();
    return new;
  end if;

  if new.advance_section_id is distinct from old.advance_section_id or new.advance_recipient_id is distinct from old.advance_recipient_id
     or new.body is distinct from old.body or new.note is distinct from old.note or new.submitted_at is distinct from old.submitted_at
     or new.advance_recipient_token_id is distinct from old.advance_recipient_token_id then
    perform private.refuse('advance_submission_immutable', 'An answer never changes after it arrives; the recipient answers again instead.');
  end if;
  if new.reviewed_at is distinct from old.reviewed_at or new.reviewed_by is distinct from old.reviewed_by
     or new.review_outcome is distinct from old.review_outcome or new.return_reason is distinct from old.return_reason then
    if old.reviewed_at is not null then
      perform private.refuse('advance_submission_reviewed', 'An answer is reviewed once.');
    end if;
    v_reviewer := private.current_person_id();
    if v_reviewer is null then
      perform private.refuse('advance_review_person', 'A review is made by a signed-in person.');
    end if;
    select coalesce(t.claimed_by, old.created_by) into v_submitter
    from (select old.advance_recipient_token_id as id) x
    left join app.advance_recipient_tokens t on t.id = x.id;
    if v_submitter = v_reviewer then
      perform private.refuse('sod_advance_submitter', 'The person who submitted an advance answer cannot review it.');
    end if;
    new.reviewed_by := v_reviewer;
    new.reviewed_at := now();
  end if;
  return new;
end;
$$;
comment on function private.guard_advance_submission() is 'Answers reach only sent packets from recipients of the same packet, arrive unreviewed, one at a time per section and recipient until the latest is Returned (advance_answer_pending), never on a Crew Roster section (advance_section_derived), typed ones only from private.record_advance_answer (advance_typed_answer_rpc, R9); they never change and are reviewed once by someone other than their submitter, stamped with the reviewer and the database time.';
revoke all on function private.guard_advance_submission() from public, anon, authenticated;

-- Lines and files are validated against the section kind --------------------------------------------------------------

create or replace function private.guard_advance_submission_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section app.advance_sections;
  v_recipient app.advance_recipients;
  v_count integer;
begin
  if not private.in_trusted_operation('record_advance_answer') then
    perform private.refuse('advance_line_direct', 'Answer lines are written with the answer by app.submit_advance_answer.');
  end if;
  select s.* into v_section from app.advance_submissions a join app.advance_sections s on s.id = a.advance_section_id
  where a.id = new.advance_submission_id;
  select r.* into v_recipient from app.advance_submissions a join app.advance_recipients r on r.id = a.advance_recipient_id
  where a.id = new.advance_submission_id;

  if v_section.section_kind = 'Schedule Window' then
    if new.needed_window is null or num_nonnulls(new.asset_class_id, new.credential_category_id, new.roster_entry_id, new.quantity, new.note) > 0 then
      perform private.refuse('advance_line_kind', 'A schedule window line gives a start, an end and a time zone only.');
    end if;
  elsif v_section.section_kind = 'Item Request' then
    if new.asset_class_id is null or new.quantity is null or not exists (
        select 1 from app.advance_section_choices c
        where c.advance_section_id = v_section.id and c.asset_class_id = new.asset_class_id and c.deleted_at is null) then
      perform private.refuse('advance_line_kind', 'An item line names one of the section''s items and a quantity.');
    end if;
    if v_section.per_person <> (new.roster_entry_id is not null) then
      perform private.refuse('advance_line_person', case when v_section.per_person then 'Each item line names a person on the roster.'
        else 'This section asks for the party''s items, not per person.' end);
    end if;
  elsif v_section.section_kind = 'Credential Request' then
    if new.credential_category_id is null or new.quantity is null or not exists (
        select 1 from app.advance_section_choices c
        where c.advance_section_id = v_section.id and c.credential_category_id = new.credential_category_id and c.deleted_at is null) then
      perform private.refuse('advance_line_kind', 'A credential line names one of the section''s categories and a quantity.');
    end if;
    if v_section.per_person and new.roster_entry_id is null then
      perform private.refuse('advance_line_person', 'Each credential line names a person on the roster.');
    end if;
    if new.roster_entry_id is not null and new.quantity <> 1 then
      perform private.refuse('advance_line_kind', 'A credential for a named person is for one.');
    end if;
  else
    perform private.refuse('advance_line_kind', 'This section takes no lines.');
  end if;

  if new.roster_entry_id is not null and not exists (
      select 1 from app.engagement_roster_entries e
      where e.id = new.roster_entry_id and e.engagement_id = v_recipient.engagement_id
        and e.deleted_at is null and e.entry_state <> 'Withdrawn') then
    perform private.refuse('advance_line_roster_entry', 'A line names a person on this engagement''s roster who was not withdrawn.');
  end if;
  if new.window_zone is not null then
    perform private.assert_time_zone(new.window_zone);
  end if;
  select count(*) into v_count from app.advance_submission_lines l where l.advance_submission_id = new.advance_submission_id;
  if v_count + 1 > v_section.max_lines then
    perform private.refuse('advance_line_limit', format('This section takes at most %s lines.', v_section.max_lines));
  end if;
  return new;
end;
$$;
comment on function private.guard_advance_submission_line() is 'Advance answer lines (R9): written only inside record_advance_answer (advance_line_direct) and held to the section kind (advance_line_kind): a Schedule Window line is a window and zone only; an Item Request line one of the section''s asset classes with a quantity and a person exactly when the section is per person (advance_line_person); a Credential Request line one of its categories with a quantity, 1 when a person is named, and a person on every line of a per-person section. A named person is on the recipient''s engagement roster and not withdrawn (advance_line_roster_entry); an answer holds at most max_lines lines (advance_line_limit).';
revoke all on function private.guard_advance_submission_line() from public, anon, authenticated;
create trigger t40_guard_advance_submission_line before insert on app.advance_submission_lines
  for each row execute function private.guard_advance_submission_line();

create or replace function private.guard_advance_submission_file()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section app.advance_sections;
begin
  if not private.in_trusted_operation('record_advance_answer') then
    perform private.refuse('advance_line_direct', 'Answer files are attached with the answer by app.submit_advance_answer.');
  end if;
  select s.* into v_section from app.advance_submissions a join app.advance_sections s on s.id = a.advance_section_id
  where a.id = new.advance_submission_id;
  if v_section.section_kind <> 'File' then
    perform private.refuse('advance_file_document', 'Only a file section takes files.');
  end if;
  if (select count(*) from app.advance_submission_files f where f.advance_submission_id = new.advance_submission_id) + 1
     > v_section.max_lines then
    perform private.refuse('advance_line_limit', format('This section takes at most %s files.', v_section.max_lines));
  end if;
  return new;
end;
$$;
comment on function private.guard_advance_submission_file() is 'Advance answer files (R9): attached only inside record_advance_answer (advance_line_direct), only to a File section''s answer (advance_file_document), at most max_lines per answer (advance_line_limit).';
revoke all on function private.guard_advance_submission_file() from public, anon, authenticated;
create trigger t40_guard_advance_submission_file before insert on app.advance_submission_files
  for each row execute function private.guard_advance_submission_file();

-- 6. The allocation a line asked for ----------------------------------------------------------------------------------------

alter table app.advance_allocations add column advance_submission_line_id uuid references app.advance_submission_lines (id);
create unique index advance_allocations_answer_line_key on app.advance_allocations (advance_submission_line_id)
  where advance_submission_line_id is not null;
comment on column app.advance_allocations.advance_submission_line_id is 'Advance answer line the allocation was requested from (R9); the answer''s review approves or declines it. Set once by private.record_advance_answer; NULL for allocations requested or assigned directly.';

create or replace function private.guard_allocation_answer_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.advance_submission_line_id is not null then
      perform private.refuse('allocation_immutable', 'An allocation is linked to its answer line by private.record_advance_answer.');
    end if;
  elsif new.advance_submission_line_id is distinct from old.advance_submission_line_id
        and (old.advance_submission_line_id is not null or not private.in_trusted_operation('record_advance_answer')) then
    perform private.refuse('allocation_immutable', 'An allocation keeps the answer line it was requested from.');
  end if;
  return new;
end;
$$;
comment on function private.guard_allocation_answer_line() is 'Advance allocations (R9): advance_submission_line_id is set once, by private.record_advance_answer, and never changes (allocation_immutable).';
revoke all on function private.guard_allocation_answer_line() from public, anon, authenticated;
create trigger t42_guard_allocation_answer_line before insert or update of advance_submission_line_id on app.advance_allocations
  for each row execute function private.guard_allocation_answer_line();

-- 5. The one writer ------------------------------------------------------------------------------------------------------------

create or replace function private.record_advance_answer(
  p_recipient_id uuid,
  p_section_id uuid,
  p_text text,
  p_note text,
  p_lines jsonb,
  p_document_ids uuid[],
  p_token_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recipient app.advance_recipients;
  v_section app.advance_sections;
  v_packet app.advance_packets;
  v_engagement app.engagements;
  v_project app.projects;
  v_kind app.advance_section_kind;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_lines jsonb := coalesce(p_lines, '[]'::jsonb);
  v_docs uuid[] := coalesce(p_document_ids, '{}');
  v_line jsonb;
  v_summary jsonb := '[]'::jsonb;
  v_titles text[] := '{}';
  v_title text;
  v_body text;
  v_id uuid;
  v_line_id uuid;
  v_number smallint := 0;
  v_from timestamptz;
  v_to timestamptz;
  v_zone text;
  v_class app.asset_classes;
  v_category app.credential_categories;
  v_entry uuid;
  v_quantity integer;
  v_label text;
  v_allocation app.advance_allocations;
  v_doc uuid;
  v_prefix text;
  v_i integer := 0;
begin
  select r.* into v_recipient from app.advance_recipients r where r.id = p_recipient_id and r.deleted_at is null;
  select s.* into v_section from app.advance_sections s
  where s.id = p_section_id and s.deleted_at is null and s.advance_packet_id = v_recipient.advance_packet_id;
  if v_recipient.id is null or v_section.id is null then
    perform private.refuse('advance_section_open', 'Answers go to a live section of the recipient''s packet.');
  end if;
  select p.* into v_packet from app.advance_packets p where p.id = v_section.advance_packet_id;
  select pr.* into v_project from app.projects pr where pr.id = v_packet.project_id;
  v_kind := v_section.section_kind;
  if v_recipient.engagement_id is not null then
    select e.* into v_engagement from app.engagements e where e.id = v_recipient.engagement_id;
  end if;

  if v_kind in ('Item Request', 'Credential Request', 'Guest List') and v_engagement.id is null then
    perform private.refuse('advance_recipient_engagement', 'This section is answered under an engagement; ask the producer to link one.');
  end if;
  if v_kind = 'Guest List' and v_engagement.role_type in ('Contractor', 'Sponsor') then
    perform private.refuse('advance_section_role', 'Guest lists are not part of a contractor''s or sponsor''s advance.');
  end if;
  if jsonb_typeof(v_lines) <> 'array' then
    perform private.refuse('advance_line_kind', 'Lines are a list.');
  end if;
  if v_kind <> 'File' and cardinality(v_docs) > 0 then
    perform private.refuse('advance_file_document', 'Only a file section takes files.');
  end if;
  if v_kind not in ('Schedule Window', 'Item Request', 'Credential Request') and jsonb_array_length(v_lines) > 0 then
    perform private.refuse('advance_line_kind', 'This section takes no lines.');
  end if;

  if v_kind = 'Text' then
    v_body := btrim(coalesce(p_text, ''));
    if char_length(v_body) not between 1 and 20000 then
      perform private.refuse('advance_answer_length', 'An answer runs 1 to 20,000 characters.');
    end if;
  elsif v_kind = 'File' then
    if cardinality(v_docs) not between 1 and v_section.max_lines then
      perform private.refuse('advance_file_document', format('Attach 1 to %s files.', v_section.max_lines));
    end if;
    v_prefix := format('storage://party-uploads/%s/advance/%s/%s/', v_recipient.org_id, v_recipient.id, v_section.id);
    foreach v_doc in array v_docs loop
      select d.title into v_title from app.documents d
      where d.id = v_doc and d.org_id = v_recipient.org_id and d.deleted_at is null
        and exists (select 1 from app.document_versions v where v.document_id = d.id and starts_with(v.storage_uri, v_prefix))
        and not exists (select 1 from app.advance_submission_files f where f.document_id = d.id);
      if v_title is null then
        perform private.refuse('advance_file_document', 'Each file is uploaded for this recipient and section and attached once.');
      end if;
      v_titles := v_titles || v_title;
    end loop;
  elsif v_kind in ('Schedule Window', 'Item Request', 'Credential Request') then
    if jsonb_array_length(v_lines) not between 1 and v_section.max_lines then
      perform private.refuse('advance_line_limit', format('Give 1 to %s lines.', v_section.max_lines));
    end if;
  end if;

  -- The summary is built before the answer goes in, from the same values the lines will hold.
  for v_line in select l from jsonb_array_elements(v_lines) l loop
    v_from := nullif(v_line ->> 'needed_window_start', '')::timestamptz;
    v_to := nullif(v_line ->> 'needed_window_end', '')::timestamptz;
    v_zone := coalesce(nullif(v_line ->> 'window_zone', ''), case when v_from is not null then v_project.time_zone end);
    if (v_from is null) <> (v_to is null) or v_to <= v_from then
      perform private.refuse('advance_line_window', 'A window runs from a start to a later end.');
    end if;
    v_label := null;
    if v_kind = 'Item Request' then
      select c.* into v_class from app.asset_classes c where c.id = nullif(v_line ->> 'asset_class_id', '')::uuid;
      v_label := coalesce(v_class.element_id, v_class.name);
    elsif v_kind = 'Credential Request' then
      select k.* into v_category from app.credential_categories k where k.id = nullif(v_line ->> 'credential_category_id', '')::uuid;
      v_label := v_category.name;
    end if;
    v_summary := v_summary || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'label', v_label,
      'quantity', nullif(v_line ->> 'quantity', ''),
      'roster_entry_id', nullif(v_line ->> 'roster_entry_id', ''),
      'from', to_char(v_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'to', to_char(v_to at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'zone', case when v_from is not null then v_zone end)));
  end loop;
  if v_kind <> 'Text' then
    v_body := private.advance_answer_summary(v_kind, v_summary, v_titles);
  end if;

  perform private.begin_trusted_operation('record_advance_answer');
  if p_token_id is not null then
    perform private.begin_trusted_operation('submit_advance');
  end if;
  insert into app.advance_submissions (advance_section_id, advance_recipient_id, advance_recipient_token_id, body, note)
  values (v_section.id, v_recipient.id, p_token_id, v_body, v_note)
  returning id into v_id;
  if p_token_id is not null then
    perform private.end_trusted_operation('submit_advance');
  end if;

  foreach v_doc in array v_docs loop
    v_i := v_i + 1;
    insert into app.advance_submission_files (advance_submission_id, document_id, position) values (v_id, v_doc, v_i);
  end loop;

  for v_line in select l from jsonb_array_elements(v_lines) l loop
    v_number := v_number + 1;
    v_from := nullif(v_line ->> 'needed_window_start', '')::timestamptz;
    v_to := nullif(v_line ->> 'needed_window_end', '')::timestamptz;
    v_zone := coalesce(nullif(v_line ->> 'window_zone', ''), case when v_from is not null then v_project.time_zone end);
    v_entry := nullif(v_line ->> 'roster_entry_id', '')::uuid;
    v_quantity := nullif(v_line ->> 'quantity', '')::integer;
    insert into app.advance_submission_lines (advance_submission_id, line_number, asset_class_id, credential_category_id,
      roster_entry_id, quantity, needed_window, window_zone, note)
    values (v_id, v_number, nullif(v_line ->> 'asset_class_id', '')::uuid, nullif(v_line ->> 'credential_category_id', '')::uuid,
      v_entry, v_quantity, case when v_from is not null then tstzrange(v_from, v_to, '[)') end, v_zone,
      nullif(btrim(coalesce(v_line ->> 'note', '')), ''))
    returning id into v_line_id;

    if v_kind in ('Item Request', 'Credential Request') then
      if v_kind = 'Item Request' then
        select c.* into v_class from app.asset_classes c where c.id = (v_line ->> 'asset_class_id')::uuid;
        if v_class.offering is null then
          perform private.refuse('offering_not_offered', 'That item is a site asset, not an offering.');
        end if;
      end if;
      -- A line without a window is needed for the engagement's dates in the project's zone.
      if v_from is null then
        v_from := (v_engagement.start_date::timestamp) at time zone v_project.time_zone;
        v_to := ((coalesce(v_engagement.end_date, v_engagement.start_date) + 1)::timestamp) at time zone v_project.time_zone;
        v_zone := v_project.time_zone;
      end if;
      perform private.assert_allocation_holder(v_project.id, case when v_entry is null then v_engagement.id end, v_entry, 'request');
      v_allocation := private.insert_allocation(v_project.id, case when v_entry is null then v_engagement.id end, v_entry,
        case when v_kind = 'Credential Request' then (v_line ->> 'credential_category_id')::uuid end,
        case when v_kind = 'Item Request' then (v_line ->> 'asset_class_id')::uuid end,
        null, null, null, v_quantity, v_from, v_to, v_zone, nullif(btrim(coalesce(v_line ->> 'note', '')), ''),
        'Requested', 'request');
      update app.advance_allocations set advance_submission_line_id = v_line_id where id = v_allocation.id;
    end if;
  end loop;
  perform private.end_trusted_operation('record_advance_answer');
  return v_id;
end;
$$;
comment on function private.record_advance_answer(uuid, uuid, text, text, jsonb, uuid[], uuid) is 'The single writer of advance answers of every kind (R9); callers authorize first. Text: the body, 1 to 20,000 characters. File: 1 to max_lines documents registered from party-uploads under <org>/advance/<recipient>/<section>/, each attached once (advance_file_document). Schedule Window, Item Request and Credential Request: 1 to max_lines lines (advance_line_limit) of p_lines [{asset_class_id | credential_category_id, quantity, roster_entry_id, needed_window_start, needed_window_end, window_zone, note}], the zone defaulting to the project''s. Item Request, Credential Request and Guest List need the recipient''s engagement (advance_recipient_engagement); Guest List is refused for Contractor and Sponsor engagements (advance_section_role). Typed answers get the summary body of private.advance_answer_summary. Each item and credential line becomes a Requested allocation of the engagement''s pool or the named person through R7''s private.assert_allocation_holder and private.insert_allocation (offerings, caps, a site asset refused offering_not_offered), needed for the line''s window or the engagement''s dates, linked by advance_submission_line_id. p_token_id records a token answer (R10). Returns the answer id.';
revoke all on function private.record_advance_answer(uuid, uuid, text, text, jsonb, uuid[], uuid) from public, anon, authenticated;
grant execute on function private.record_advance_answer(uuid, uuid, text, text, jsonb, uuid[], uuid) to service_role;

create or replace function app.submit_advance_answer(
  p_recipient_id uuid,
  p_section_id uuid,
  p_text text default null,
  p_note text default null,
  p_lines jsonb default '[]',
  p_document_ids uuid[] default '{}'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recipient app.advance_recipients;
  v_project uuid;
begin
  perform private.require_person();
  select r.* into v_recipient from app.advance_recipients r where r.id = p_recipient_id and r.deleted_at is null;
  select p.project_id into v_project from app.advance_packets p where p.id = v_recipient.advance_packet_id;
  if v_recipient.id is null or not private.advance_recipient_open(v_project, v_recipient.person_id, v_recipient.counterparty_id) then
    raise exception using errcode = '42501', message = 'only the recipient side answers this packet';
  end if;
  return private.record_advance_answer(p_recipient_id, p_section_id, p_text, p_note, p_lines, p_document_ids, null);
end;
$$;
comment on function app.submit_advance_answer(uuid, uuid, text, text, jsonb, uuid[]) is 'A signed-in recipient (the person, their Advance representative, or the recipient account, while the engagement''s onboarding or operational area is open; anyone else 42501) answers a section of any kind through private.record_advance_answer (R9). One answer at a time per section (advance_answer_pending). Returns the answer id.';
revoke all on function app.submit_advance_answer(uuid, uuid, text, text, jsonb, uuid[]) from public, anon;
grant execute on function app.submit_advance_answer(uuid, uuid, text, text, jsonb, uuid[]) to authenticated, service_role;

-- 6. The review decides the allocations -----------------------------------------------------------------------------------

create or replace function private.on_answer_reviewed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allocation uuid;
  v_hint text;
begin
  perform private.begin_trusted_operation('advance_answer_review');
  for v_allocation in
    select a.id from app.advance_allocations a
    join app.advance_submission_lines l on l.id = a.advance_submission_line_id
    where l.advance_submission_id = new.id and a.allocation_state = 'Requested' and a.deleted_at is null
    order by l.line_number
  loop
    if new.review_outcome = 'Accepted' then
      begin
        perform app.decide_allocation(v_allocation, 'Approved', null, null);
      exception when sqlstate 'XR001' then
        get stacked diagnostics v_hint = pg_exception_hint;
        -- These need a reviewer's decision in the Allocations queue; anything else rolls the review back.
        if v_hint not in ('allocation_sources_required', 'reservation_over_capacity', 'allocation_over_allowance_reason',
                          'allocation_entry_not_accepted') then
          raise;
        end if;
      end;
    else
      perform app.decide_allocation(v_allocation, 'Rejected', new.return_reason, null);
    end if;
  end loop;
  perform private.end_trusted_operation('advance_answer_review');
  return null;
end;
$$;
comment on function private.on_answer_reviewed() is 'After an advance answer is reviewed (R9): Accepted approves each linked Requested allocation through app.decide_allocation, as the reviewer, in its own subtransaction; one that needs sources (allocation_sources_required), finds no capacity (reservation_over_capacity), goes beyond the allowance (allocation_over_allowance_reason) or names a person not yet accepted (allocation_entry_not_accepted) stays Requested for the Allocations queue while the review commits. Returned declines them with the return reason. The requester separation of R7 holds.';
revoke all on function private.on_answer_reviewed() from public, anon, authenticated;
create trigger t91_answer_review_allocations after update of review_outcome on app.advance_submissions
  for each row when (old.review_outcome is null and new.review_outcome is not null)
  execute function private.on_answer_reviewed();

-- 7. Dock slots from an accepted window ---------------------------------------------------------------------------------------

alter table app.dock_slots add column advance_submission_line_id uuid references app.advance_submission_lines (id);
create unique index dock_slots_answer_line_key on app.dock_slots (advance_submission_line_id) where advance_submission_line_id is not null;
comment on column app.dock_slots.advance_submission_line_id is 'Accepted Load In or Load Out answer line the slot was booked from (R9), at most one slot per line; NULL for slots booked directly.';

create or replace function private.guard_dock_slot_answer_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.advance_submission_line_id is not null and not private.in_trusted_operation('book_dock_slot_from_answer'))
     or (tg_op = 'UPDATE' and new.advance_submission_line_id is distinct from old.advance_submission_line_id) then
    perform private.refuse('advance_line_booked', 'A slot is booked from an answer with app.book_dock_slot_from_answer and keeps its line.');
  end if;
  return new;
end;
$$;
comment on function private.guard_dock_slot_answer_line() is 'Dock slots (R9): advance_submission_line_id is set only by app.book_dock_slot_from_answer and never changes (advance_line_booked).';
revoke all on function private.guard_dock_slot_answer_line() from public, anon, authenticated;
create trigger t42_guard_dock_slot_answer_line before insert or update on app.dock_slots
  for each row execute function private.guard_dock_slot_answer_line();

create or replace function app.book_dock_slot_from_answer(p_line_id uuid, p_zone_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_line app.advance_submission_lines;
  v_answer app.advance_submissions;
  v_section app.advance_sections;
  v_project uuid;
  v_engagement uuid;
  v_id uuid;
begin
  perform private.require_person();
  select l.* into v_line from app.advance_submission_lines l where l.id = p_line_id;
  select a.* into v_answer from app.advance_submissions a where a.id = v_line.advance_submission_id and a.deleted_at is null;
  select s.* into v_section from app.advance_sections s where s.id = v_answer.advance_section_id;
  select p.project_id into v_project from app.advance_packets p where p.id = v_section.advance_packet_id;
  if v_line.id is null or v_answer.id is null or not private.can_on_project(v_project, 'logistics.dock_slot.write') then
    raise exception using errcode = '42501', message = 'logistics.dock_slot.write is required on the project';
  end if;
  if v_section.section_kind <> 'Schedule Window' or v_section.window_kind not in ('Load In', 'Load Out') then
    perform private.refuse('advance_line_not_dock', 'Only a Load In or Load Out window is booked as a dock slot.');
  end if;
  if v_answer.review_outcome is distinct from 'Accepted' then
    perform private.refuse('advance_line_not_accepted', 'Accept the answer before booking its window.');
  end if;
  if exists (select 1 from app.dock_slots d where d.advance_submission_line_id = v_line.id and d.deleted_at is null) then
    perform private.refuse('advance_line_booked', 'This window already has a dock slot.');
  end if;
  if not exists (select 1 from app.zones z where z.id = p_zone_id and z.org_id = v_answer.org_id and z.deleted_at is null) then
    perform private.refuse('advance_dock_zone', 'Choose a live dock zone of the org.');
  end if;
  select r.engagement_id into v_engagement from app.advance_recipients r where r.id = v_answer.advance_recipient_id;
  perform private.begin_trusted_operation('book_dock_slot_from_answer');
  insert into app.dock_slots (project_id, zone_id, starts_at, ends_at, engagement_id, advance_submission_line_id)
  values (v_project, p_zone_id, lower(v_line.needed_window), upper(v_line.needed_window), v_engagement, v_line.id)
  returning id into v_id;
  perform private.end_trusted_operation('book_dock_slot_from_answer');
  return v_id;
end;
$$;
comment on function app.book_dock_slot_from_answer(uuid, uuid) is 'Books an Accepted Load In or Load Out window of an advance answer as a dock slot at a dock zone of the project (R9): logistics.dock_slot.write on the project (42501 otherwise); a window of another kind refuses advance_line_not_dock, an answer not Accepted advance_line_not_accepted, a line already booked advance_line_booked, a zone that is not a live zone of the org advance_dock_zone. The slot is the recipient''s engagement''s, so it shows on its Deliveries tab; the overlap guard of 0351 applies (dock_slot_overlap). Returns the slot id.';
revoke all on function app.book_dock_slot_from_answer(uuid, uuid) from public, anon;
grant execute on function app.book_dock_slot_from_answer(uuid, uuid) to authenticated, service_role;
