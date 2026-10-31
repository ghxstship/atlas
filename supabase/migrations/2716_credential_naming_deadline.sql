-- 2716_credential_naming_deadline.sql
-- R9 parity addition G-141 (RRR-189; competitor parity audit 2026-10-28, owner-approved). A naming deadline per
-- advance recipient: until it passes, the party names, renames and unnames the people on the credential passes it
-- requested through the recipient's answers; after it, only the producing org changes them.
--
--   * app.advance_recipients.names_due_at, editable after send by advancing.packet.write holders under the 0351 child
--     policy (a deadline, not packet content), only for a recipient with an engagement.
--   * private.allocation_names_due_at: the deadline of an allocation, or of a Split share's pool, through the answer
--     line it was requested from; NULL for allocations not requested through an answer.
--   * t43_guard_credential_naming_deadline: after the deadline, a caller without advancing.packet.write on the project
--     neither splits a credential pool to a person, nor withdraws a named share, nor returns quantity to the pool
--     (credential_names_closed). Cascades (engagement_close, roster_entry_close, allocation_assign, and withdrawals
--     caused by an entry removed or an engagement ended) are never blocked.
--   * private.record_advance_answer (from 2711): a Credential Request line naming a person after the deadline refuses
--     credential_names_closed; pool lines still become Requested allocations for review.
--   * api_external.my_advance_recipients (from 2714) and api_external.advance_allocations (from 2701) append
--     names_due_at, so Gateway shows the deadline and disables naming after it.
-- Unnamed quantity is never stored: named is the sum of the live Requested or Approved Split shares of a pool, and
-- unnamed is the pool's own current quantity.

alter table app.advance_recipients add column names_due_at timestamptz,
  add constraint advance_recipients_names_due_engagement check (names_due_at is null or engagement_id is not null);
comment on column app.advance_recipients.names_due_at is 'After this instant the party can no longer name, rename or unname people on credential allowances requested through this recipient; the producing org still can (G-141, R9). Only with an engagement; editable after send.';

create or replace function private.allocation_names_due_at(p_allocation_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select r.names_due_at
  from app.advance_allocations a
  left join app.advance_allocations pool on pool.id = a.parent_allocation_id and a.origin = 'Split'
  join app.advance_submission_lines l on l.id = coalesce(pool.advance_submission_line_id, a.advance_submission_line_id)
  join app.advance_submissions s on s.id = l.advance_submission_id
  join app.advance_recipients r on r.id = s.advance_recipient_id
  where a.id = p_allocation_id;
$$;
comment on function private.allocation_names_due_at(uuid) is 'The naming deadline of an allocation (G-141, R9): for a Split share its pool''s, otherwise its own, read through the answer line it was requested from to the recipient''s names_due_at. NULL for an allocation not requested through an answer, or a recipient without a deadline.';
revoke all on function private.allocation_names_due_at(uuid) from public, anon, authenticated;

create or replace function private.guard_credential_naming_deadline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due timestamptz;
begin
  if new.credential_category_id is null
     or private.in_trusted_operation('engagement_close') or private.in_trusted_operation('roster_entry_close')
     or private.in_trusted_operation('allocation_assign')
     or new.withdraw_cause in ('Entry Removed', 'Engagement Ended') then
    return new;
  end if;
  if not ((tg_op = 'INSERT' and new.origin = 'Split')
          or (tg_op = 'UPDATE' and new.origin = 'Split' and new.allocation_state = 'Withdrawn' and old.allocation_state <> 'Withdrawn')
          or (tg_op = 'UPDATE' and new.origin <> 'Split' and new.quantity > old.quantity)) then
    return new;
  end if;
  v_due := private.allocation_names_due_at(case when new.origin = 'Split' then new.parent_allocation_id else new.id end);
  if v_due is null or v_due > now() or private.can_on_project(new.project_id, 'advancing.packet.write') then
    return new;
  end if;
  perform private.refuse('credential_names_closed', 'Passes can no longer be named; ask the producer to change them.');
  return new;
end;
$$;
comment on function private.guard_credential_naming_deadline() is 'G-141 (R9): once the naming deadline of a credential allocation requested through an answer has passed, a caller without advancing.packet.write on the project cannot split the pool to a person, withdraw a named share or return quantity to the pool (credential_names_closed); production still can. The cascades of engagement_close, roster_entry_close and allocation_assign, and withdrawals caused by an entry removed or an engagement ended, are never blocked.';
revoke all on function private.guard_credential_naming_deadline() from public, anon, authenticated;
create trigger t43_guard_credential_naming_deadline before insert or update of allocation_state, quantity on app.advance_allocations
  for each row execute function private.guard_credential_naming_deadline();

-- The one writer, from 2711 -------------------------------------------------------------------------------------------------

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
      -- G-141: after the recipient's naming deadline a person is no longer named; a pool line still goes in for review.
      if v_kind = 'Credential Request' and v_entry is not null and v_recipient.names_due_at <= now() then
        perform private.refuse('credential_names_closed', 'Passes can no longer be named; ask the producer to change them.');
      end if;
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
comment on function private.record_advance_answer(uuid, uuid, text, text, jsonb, uuid[], uuid) is 'The single writer of advance answers of every kind (R9); callers authorize first. Text: the body, 1 to 20,000 characters. File: 1 to max_lines documents registered from party-uploads under <org>/advance/<recipient>/<section>/, each attached once (advance_file_document). Schedule Window, Item Request and Credential Request: 1 to max_lines lines (advance_line_limit) of p_lines [{asset_class_id | credential_category_id, quantity, roster_entry_id, needed_window_start, needed_window_end, window_zone, note}], the zone defaulting to the project''s. Item Request, Credential Request and Guest List need the recipient''s engagement (advance_recipient_engagement); Guest List is refused for Contractor and Sponsor engagements (advance_section_role). Typed answers get the summary body of private.advance_answer_summary. Each item and credential line becomes a Requested allocation of the engagement''s pool or the named person through R7''s private.assert_allocation_holder and private.insert_allocation (offerings, caps, a site asset refused offering_not_offered), needed for the line''s window or the engagement''s dates, linked by advance_submission_line_id. After the recipient''s names_due_at a Credential Request line naming a person refuses credential_names_closed, while pool lines still go in (G-141, 2716). p_token_id records a token answer (R10). Returns the answer id.';
revoke all on function private.record_advance_answer(uuid, uuid, text, text, jsonb, uuid[], uuid) from public, anon, authenticated;
grant execute on function private.record_advance_answer(uuid, uuid, text, text, jsonb, uuid[], uuid) to service_role;

-- What Gateway reads, from 2714 and 2701 -------------------------------------------------------------------------------------

create or replace view api_external.my_advance_recipients as
select r.id, r.advance_packet_id, r.person_id, c.organization_id as account_id, r.engagement_id, r.names_due_at
from app.advance_recipients r
join app.advance_packets p on p.id = r.advance_packet_id and p.deleted_at is null and p.sent_at is not null
left join app.counterparties c on c.id = r.counterparty_id
where r.deleted_at is null and private.advance_recipient_open(p.project_id, r.person_id, r.counterparty_id);

call private.describe('api_external.my_advance_recipients', 'Advance recipients the caller answers for: themselves, their account, or a represented artist with the Advance scope, on sent packets.', array[
  'id', 'Recipient.', 'advance_packet_id', 'Packet.', 'person_id', 'Recipient person.', 'account_id', 'Recipient account.',
  'engagement_id', 'Engagement the recipient answers under (R9); NULL when none is linked.',
  'names_due_at', 'When the party stops naming people on the passes requested through this recipient (G-141); NULL without a deadline.']);

create or replace view api_external.advance_allocations as
select s.allocation_id, x.engagement_id, s.roster_entry_id,
  case when s.roster_entry_id is not null then pp.full_name end as person_name,
  s.kind, s.item_name, s.quantity, s.allocation_state, s.display_status, s.reserved_quantity, s.issued_quantity,
  s.returned_quantity, s.parent_allocation_id, lower(s.needed_during) as needed_from, upper(s.needed_during) as needed_to,
  s.needed_time_zone, s.requested_by = private.current_person_id() as requested_by_me, s.decline_reason,
  nd.names_due_at
from private.advance_allocation_status_rows s
cross join lateral (
  select coalesce(s.holder_engagement_id, (select r.engagement_id from app.engagement_roster_entries r where r.id = s.roster_entry_id))
    as engagement_id
) x
left join private.roster_people rp on rp.roster_entry_id = s.roster_entry_id
left join app.people pp on pp.id = rp.person_id
-- private.allocation_names_due_at, inline: a function in a view runs with the reader's execute privilege.
left join lateral (
  select r.names_due_at from app.advance_allocations a
  left join app.advance_allocations pool on pool.id = a.parent_allocation_id and a.origin = 'Split'
  join app.advance_submission_lines l on l.id = coalesce(pool.advance_submission_line_id, a.advance_submission_line_id)
  join app.advance_submissions sub on sub.id = l.advance_submission_id
  join app.advance_recipients r on r.id = sub.advance_recipient_id
  where a.id = s.allocation_id and s.kind = 'Credential'
) nd on true
where x.engagement_id in (select private.my_engagement_ids('roster'))
   or s.roster_entry_id in (select private.my_roster_entry_ids('roster'));

call private.describe('api_external.advance_allocations', 'What a party''s engagement is allocated (R8, ADR 0103 and 0104): its pool and the share of each person on its roster, for the party side (the engagements whose roster area the caller reaches: the engaged person of an Artist engagement or one no account supplies, the supplying account''s Owner or Admin, an Advancing Lead, an Advance representative), and a person''s own rows on their entries. The status is computed (app.advance_allocation_status); prices, order numbers, vendors and other people''s asset tags never appear.', array[
  'allocation_id', 'Allocation.',
  'engagement_id', 'Engagement it is held under: the pool''s own, or the roster entry''s.',
  'roster_entry_id', 'Roster entry of the person who holds it; NULL for the party''s pool.',
  'person_name', 'Name of the person who holds it; NULL for the pool.',
  'kind', 'Credential, Parking Pass, Asset, Catering, Lodging, Travel or Per Diem.',
  'item_name', 'Category, class, catering or block name; NULL for Travel and Per Diem.',
  'quantity', 'Quantity allocated; a pool goes down as it is shared out.',
  'allocation_state', 'Requested, Approved, Declined or Withdrawn.',
  'display_status', 'Computed status: Declined, Withdrawn or Requested; for Approved, Returned, Revoked, Issued, Partly Issued, Awaiting Order, On Order, Confirmed, Received, Reserved or Approved.',
  'reserved_quantity', 'Quantity held for it.',
  'issued_quantity', 'Quantity handed over.',
  'returned_quantity', 'Quantity handed back.',
  'parent_allocation_id', 'Pool a person''s share was split from.',
  'needed_from', 'When it is needed from.',
  'needed_to', 'When it is needed until.',
  'needed_time_zone', 'IANA time zone of the window.',
  'requested_by_me', 'True when the caller asked for it.',
  'decline_reason', 'Why production declined it.',
  'names_due_at', 'For a credential pool or a share of one requested through an advance answer, when the party stops naming people on it (G-141, R9); NULL otherwise.'
]);

revoke all on api_external.my_advance_recipients, api_external.advance_allocations from public, anon;
grant select on api_external.my_advance_recipients, api_external.advance_allocations to authenticated, service_role;
