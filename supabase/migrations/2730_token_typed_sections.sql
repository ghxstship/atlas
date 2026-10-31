-- 2730_token_typed_sections.sql
-- R10 Token advance parity (RRR-191, ADR 0100 and 0104; owner decisions 0/1, 6 and 8). A recipient without an account
-- (prompt line 589, 0430) answers every kind of section through the advance link that R9 lets a signed-in recipient
-- answer, and claiming the account carries the answers and the allocations they asked for across (journey 50).
--
--   1. api_public.preview_advance (from 0430) keeps its columns and order and appends each section's kind and
--      configuration, its choices (asset classes and credential categories, with names), the latest answer's id, note,
--      lines and files, whether the section takes an answer now, the guest cap and the guests used, the roster's
--      counts by state, the project's time zone and the roster people a per-person line may name.
--   2. api_public.submit_advance_typed: a typed answer through the link, written by R9's private.record_advance_answer
--      with the token, so the one-open-answer guard, the line rules and R7's allocations hold as they do signed in.
--      Item and credential lines become Requested allocations with no created_by.
--   3. private.advance_upload_tickets and api_public.begin_advance_upload / finish_advance_upload: a File section's
--      upload through the link. A ticket names one object under <org_id>/advance-token/<ticket_id>/<file name>, is open
--      for 15 minutes, and is used once; storage policies party_uploads_token_insert and party_uploads_token_read open
--      exactly that object while the ticket and its token are open (api_public.advance_upload_ticket_open, in
--      api_public because anon calls it). The scan queue of 1041 applies as to every party-uploads object, and the
--      restrictive scan read gate keeps it from org readers until it is Clean.
--   4. private.party_upload_readable (from 2712) also lets org readers with advancing.packet.read read token uploads,
--      through the ticket's section and packet.
--   5. private.record_advance_answer (from 2716) takes, for a token answer, the documents of that token's tickets for
--      the same section.
--   6. Nothing is written at claim (review correction): private.allocation_requester (from 2691) answers created_by,
--      else the person who claimed the token whose answer line created the allocation, so after the claim the claimer
--      cannot decide what their token answer asked for (sod_allocation_requester). The status rows behind
--      app.advance_allocation_status and api_external.advance_allocations (from 2701) report the same requester.
-- Every new api_public function is volatile and security definer, starts with private.resolve_advance_token (which
-- refuses a read-only transaction first, 1295), answers refusals as rows (REFUSE and the rule), and is granted to
-- anon, authenticated and service_role. Guests and the crew roster through the link are 2731.

-- 1. The requester of a token answer's allocation ---------------------------------------------------------------------

create or replace function private.allocation_requester(p_allocation_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(a.created_by, (
    select t.claimed_by
    from app.advance_submission_lines l
    join app.advance_submissions s on s.id = l.advance_submission_id
    join app.advance_recipient_tokens t on t.id = s.advance_recipient_token_id
    where l.id = a.advance_submission_line_id))
  from app.advance_allocations a where a.id = p_allocation_id;
$$;
comment on function private.allocation_requester(uuid) is 'Who requested an allocation, computed (ADR 0103 section 5): its created_by, else, for an allocation an advance link''s answer asked for (R10), the person who claimed that link; NULL until it is claimed. Nothing is stamped at claim. The separation rule sod_allocation_requester compares it.';
revoke all on function private.allocation_requester(uuid) from public, anon, authenticated;

-- The status rows report the same requester (from 2701, requested_by only).
create or replace view private.advance_allocation_status_rows as
select
  a.id as allocation_id,
  a.org_id,
  a.project_id,
  a.engagement_id as holder_engagement_id,
  a.roster_entry_id,
  a.parent_allocation_id,
  x.kind,
  x.offering,
  x.item_name,
  a.quantity,
  a.allocation_state,
  a.origin,
  a.needed_during,
  a.needed_time_zone,
  coalesce(a.created_by, (
    select t.claimed_by
    from app.advance_submission_lines l
    join app.advance_submissions sb on sb.id = l.advance_submission_id
    join app.advance_recipient_tokens t on t.id = sb.advance_recipient_token_id
    where l.id = a.advance_submission_line_id)) as requested_by,
  d.created_at as decided_at,
  d.created_by as decided_by,
  case when d.to_state = 'Declined' then d.reason end as decline_reason,
  h.reserved_quantity,
  h.on_order_quantity,
  h.confirmed,
  h.awaiting_order,
  h.received_quantity,
  p.issued_quantity,
  p.returned_quantity,
  p.lost_quantity,
  p.revoked_quantity,
  case
    when a.allocation_state = 'Declined' then 'Declined'
    when a.allocation_state = 'Withdrawn' then 'Withdrawn'
    when a.allocation_state = 'Requested' then 'Requested'
    when p.issued_quantity > 0 and p.issued_quantity = a.quantity
      and p.returned_quantity + p.lost_quantity = p.issued_quantity and x.kind not in ('Credential', 'Parking Pass') then 'Returned'
    when x.kind in ('Credential', 'Parking Pass') and p.issued_quantity > 0 and p.revoked_quantity = p.issued_quantity then 'Revoked'
    when p.issued_quantity > 0 and p.issued_quantity >= a.quantity then 'Issued'
    when p.issued_quantity > 0 then 'Partly Issued'
    when h.awaiting_order then 'Awaiting Order'
    when h.on_order_quantity > 0 and not h.confirmed then 'On Order'
    when h.on_order_quantity > 0 then 'Confirmed'
    when h.order_line_quantity > 0 and h.received_quantity > 0 then 'Received'
    when a.quantity > 0 and h.reserved_quantity >= a.quantity then 'Reserved'
    else 'Approved'
  end as display_status
from app.advance_allocations a
cross join lateral (
  select private.allocation_kind(a) as kind, private.allocation_offering_kind(a) as offering,
    coalesce(
      (select k.name from app.credential_categories k where k.id = a.credential_category_id),
      (select c.name from app.asset_classes c where c.id = a.asset_class_id),
      (select f.title from app.fulfillments f where f.id = a.fulfillment_id),
      (select b.title from app.accommodation_blocks b where b.id = a.accommodation_block_id)) as item_name
) x
left join lateral (
  select t.created_at, t.created_by, t.to_state, t.reason
  from app.advance_allocation_state_transitions t
  where t.advance_allocation_id = a.id and t.from_state = 'Requested' and t.to_state in ('Approved', 'Declined')
  order by t.created_at desc, t.id desc limit 1
) d on true
cross join lateral (
  select
    coalesce(sum(r.quantity), 0) as reserved_quantity,
    coalesce(sum(r.quantity) filter (where r.po_line_id is not null), 0) as order_line_quantity,
    coalesce(sum(greatest(r.quantity - least(r.quantity, s.received), 0))
      filter (where r.po_line_id is not null and s.po_state in ('Approved', 'Sent')), 0) as on_order_quantity,
    coalesce(bool_and(s.acknowledged) filter (where r.po_line_id is not null and s.po_state in ('Approved', 'Sent')), false) as confirmed,
    coalesce(bool_or(s.po_state = 'Proposed') filter (where r.po_line_id is not null), false) as awaiting_order,
    coalesce(sum(least(r.quantity, s.received)) filter (where r.po_line_id is not null), 0) as received_quantity
  from app.asset_reservations r
  left join lateral (
    select po.po_state,
      exists (select 1 from app.po_acknowledgments k where k.purchase_order_id = po.id and k.deleted_at is null) as acknowledged,
      coalesce((select sum(rl.quantity_received) from app.receipt_lines rl
                join app.goods_receipts g on g.id = rl.goods_receipt_id and g.deleted_at is null
                where rl.po_line_id = l.id and rl.deleted_at is null), 0) as received
    from app.po_lines l join app.purchase_orders po on po.id = l.purchase_order_id
    where l.id = r.po_line_id
  ) s on true
  where r.advance_allocation_id = a.id and r.released_at is null and r.deleted_at is null
) h
cross join lateral (
  select
    case
      when x.kind in ('Credential', 'Parking Pass') then
        (select count(*) from app.credentials c where c.allocation_id = a.id and c.deleted_at is null)
      when x.kind = 'Asset' then
        (select count(*) from (select distinct c.asset_unit_id from app.asset_custody c
          join app.asset_reservations r on r.id = c.reservation_id where r.advance_allocation_id = a.id) u)
        + (select coalesce(sum(-m.delta), 0) from app.asset_lot_movements m join app.asset_reservations r on r.id = m.reservation_id
           where r.advance_allocation_id = a.id and m.movement_kind = 'Check Out')
      when x.kind = 'Catering' then
        (select coalesce(sum(l.quantity), 0) from app.fulfillment_lines l where l.allocation_id = a.id and l.deleted_at is null)
      when x.kind = 'Lodging' then
        (select count(*) from app.accommodation_assignments s where s.allocation_id = a.id and s.deleted_at is null)
      when x.kind = 'Travel' then
        (select count(*) from app.travel_segments t where t.allocation_id = a.id and t.deleted_at is null)
      when x.kind = 'Per Diem' then
        (select count(*) from app.per_diems pd where pd.allocation_id = a.id and pd.deleted_at is null)
      else 0
    end::numeric as issued_quantity,
    case when x.kind = 'Asset' then
      (select count(*) from (
        select distinct c.asset_unit_id from app.asset_custody c
        join app.asset_reservations r on r.id = c.reservation_id
        where r.advance_allocation_id = a.id
          and exists (select 1 from app.asset_custody l where l.asset_unit_id = c.asset_unit_id
                      and (l.created_at, l.id) > (c.created_at, c.id)
                      and l.custodian_membership_id is null and l.custodian_engagement_id is null)) u)
      + (select coalesce(sum(m.delta), 0) from app.asset_lot_movements m join app.asset_reservations r on r.id = m.reservation_id
         where r.advance_allocation_id = a.id and m.movement_kind = 'Check In')
    else 0 end::numeric as returned_quantity,
    case when x.kind = 'Asset' then
      (select count(*) from (
        select distinct c.asset_unit_id from app.asset_custody c
        join app.asset_reservations r on r.id = c.reservation_id
        join app.asset_units un on un.id = c.asset_unit_id
        where r.advance_allocation_id = a.id and un.asset_state = 'Lost'
          and not exists (select 1 from app.asset_custody l where l.asset_unit_id = c.asset_unit_id
                          and (l.created_at, l.id) > (c.created_at, c.id)
                          and l.custodian_membership_id is null and l.custodian_engagement_id is null)) u)
    else 0 end::numeric as lost_quantity,
    case when x.kind in ('Credential', 'Parking Pass') then
      (select count(*) from app.credentials c where c.allocation_id = a.id and c.deleted_at is null and c.revoked_at is not null)
    else 0 end::numeric as revoked_quantity
) p
where a.deleted_at is null;

comment on view private.advance_allocation_status_rows is 'The combined status of every live allocation (R7, ADR 0103), computed from the rows that own each state: the body of app.advance_allocation_status without a row filter (2701). requested_by is private.allocation_requester written out: created_by, else the person who claimed the advance link whose answer asked for it (R10). Read only by views owned by the migration role, which filter it: app.advance_allocation_status (advancing.packet.read) and api_external.advance_allocations (the party side and the person).';
revoke all on private.advance_allocation_status_rows from public, anon, authenticated;
revoke select on private.advance_allocation_status_rows from xos_backup;

-- 2. Upload tickets ---------------------------------------------------------------------------------------------------------

create table private.advance_upload_tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id),
  advance_recipient_token_id uuid not null references app.advance_recipient_tokens (id),
  advance_section_id uuid not null references app.advance_sections (id),
  object_name text not null unique,
  content_type text not null,
  byte_size integer not null,
  expires_at timestamptz not null,
  document_id uuid unique references app.documents (id),
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint advance_upload_tickets_byte_size check (byte_size between 1 and 26214400),
  constraint advance_upload_tickets_used check ((document_id is null) = (used_at is null))
);
create index advance_upload_tickets_token_section_idx on private.advance_upload_tickets (advance_recipient_token_id, advance_section_id);
create index advance_upload_tickets_org_id_idx on private.advance_upload_tickets (org_id);
create index advance_upload_tickets_advance_section_id_idx on private.advance_upload_tickets (advance_section_id);

comment on table private.advance_upload_tickets is 'One upload an advance link may make to a File section (R10): the exact party-uploads object it opens, its declared type and size, open for 15 minutes and used once, when the file becomes a document. The id is random (never v7), since it is part of an object name an anonymous caller writes. Read only through definer functions.';
comment on column private.advance_upload_tickets.id is 'Random ticket id, also the folder of the object name.';
comment on column private.advance_upload_tickets.org_id is 'Org of the packet.';
comment on column private.advance_upload_tickets.advance_recipient_token_id is 'Advance link the ticket was issued to.';
comment on column private.advance_upload_tickets.advance_section_id is 'File section the upload answers.';
comment on column private.advance_upload_tickets.object_name is 'The one party-uploads object the ticket opens: <org_id>/advance-token/<ticket id>/<file name>.';
comment on column private.advance_upload_tickets.content_type is 'Declared content type, one the party-uploads bucket takes.';
comment on column private.advance_upload_tickets.byte_size is 'Declared size in bytes, 1 to 26214400 (25 MB).';
comment on column private.advance_upload_tickets.expires_at is 'When the ticket closes unused: 15 minutes after it was issued.';
comment on column private.advance_upload_tickets.document_id is 'Document the upload became; set with used_at.';
comment on column private.advance_upload_tickets.used_at is 'When the upload was finished and registered.';
comment on column private.advance_upload_tickets.created_at is 'When the ticket was issued.';

alter table private.advance_upload_tickets enable row level security;
revoke all on private.advance_upload_tickets from public, anon, authenticated;

create or replace function api_public.advance_upload_ticket_open(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.advance_upload_tickets k
    join app.advance_recipient_tokens t on t.id = k.advance_recipient_token_id
    where k.object_name = p_name and k.used_at is null and k.expires_at > now()
      and t.revoked_at is null and t.deleted_at is null and t.failed_attempts < 5 and t.expires_at > now());
$$;
comment on function api_public.advance_upload_ticket_open(text) is 'R10: true only for the object name of an unused, unexpired upload ticket whose advance link is not revoked, locked or expired. The storage policies party_uploads_token_insert and party_uploads_token_read call it with the object name as anon, so it lives with the token RPCs in api_public (inv_06: no definer function in app or private is executable by anon). It reads nothing but the ticket of that exact name, whose random id an anonymous caller cannot guess, and counts nothing, so it is stable.';
revoke all on function api_public.advance_upload_ticket_open(text) from public;
grant execute on function api_public.advance_upload_ticket_open(text) to anon, authenticated, service_role;

create policy party_uploads_token_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'party-uploads' and api_public.advance_upload_ticket_open(name));
comment on policy party_uploads_token_insert on storage.objects is 'R10: an advance link uploads the one object its open ticket names (api_public.begin_advance_upload).';
create policy party_uploads_token_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'party-uploads' and api_public.advance_upload_ticket_open(name));
comment on policy party_uploads_token_read on storage.objects is 'R10: the object of an open ticket is readable while the ticket is open, so the storage API''s INSERT ... RETURNING works (1041). For a signed-in caller the restrictive object_scan_read_gate still applies.';

-- 3. Org readers read token uploads, from 2712 -----------------------------------------------------------------------------

create or replace function private.party_upload_readable(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.party_upload_writable(p_object_name)
    or exists (
      select 1 from private.party_upload_target(p_object_name) t
      where private.can_on_project(t.project_id, case t.target_kind when 'advance' then 'advancing.packet.read' else 'vendors.vendor.read' end))
    or exists (
      select 1 from private.advance_upload_tickets k
      join app.advance_sections s on s.id = k.advance_section_id
      join app.advance_packets p on p.id = s.advance_packet_id
      where k.object_name = p_object_name and private.can_on_project(p.project_id, 'advancing.packet.read'));
$$;
comment on function private.party_upload_readable(text) is 'True when the signed-in person may read a party-uploads object (R9): the side that may write it, or an org member with advancing.packet.read (advance files, those an advance link uploaded through a ticket included, R10) or vendors.vendor.read (sponsor assets) on the project. The scan read gate still holds an object back from everyone but its uploader until it is Clean.';
revoke all on function private.party_upload_readable(text) from public, anon;
grant execute on function private.party_upload_readable(text) to authenticated, service_role;

-- 4. The one writer takes a token's uploads, from 2716 -------------------------------------------------------------------------

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
      -- R10: a token answer also takes the documents its own upload tickets made for this section.
      select d.title into v_title from app.documents d
      where d.id = v_doc and d.org_id = v_recipient.org_id and d.deleted_at is null
        and (exists (select 1 from app.document_versions v where v.document_id = d.id and starts_with(v.storage_uri, v_prefix))
          or (p_token_id is not null and exists (
            select 1 from private.advance_upload_tickets k
            where k.document_id = d.id and k.advance_recipient_token_id = p_token_id and k.advance_section_id = v_section.id)))
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
comment on function private.record_advance_answer(uuid, uuid, text, text, jsonb, uuid[], uuid) is 'The single writer of advance answers of every kind (R9); callers authorize first. Text: the body, 1 to 20,000 characters. File: 1 to max_lines documents registered from party-uploads under <org>/advance/<recipient>/<section>/, or for a token answer made from that token''s upload tickets for the section (R10), each attached once (advance_file_document). Schedule Window, Item Request and Credential Request: 1 to max_lines lines (advance_line_limit) of p_lines [{asset_class_id | credential_category_id, quantity, roster_entry_id, needed_window_start, needed_window_end, window_zone, note}], the zone defaulting to the project''s. Item Request, Credential Request and Guest List need the recipient''s engagement (advance_recipient_engagement); Guest List is refused for Contractor and Sponsor engagements (advance_section_role). Typed answers get the summary body of private.advance_answer_summary. Each item and credential line becomes a Requested allocation of the engagement''s pool or the named person through R7''s private.assert_allocation_holder and private.insert_allocation (offerings, caps, a site asset refused offering_not_offered), needed for the line''s window or the engagement''s dates, linked by advance_submission_line_id. After the recipient''s names_due_at a Credential Request line naming a person refuses credential_names_closed, while pool lines still go in (G-141, 2716). p_token_id records a token answer (R10). Returns the answer id.';
revoke all on function private.record_advance_answer(uuid, uuid, text, text, jsonb, uuid[], uuid) from public, anon, authenticated;
grant execute on function private.record_advance_answer(uuid, uuid, text, text, jsonb, uuid[], uuid) to service_role;

-- 5. Helpers of the token RPCs ------------------------------------------------------------------------------------------------

create or replace function private.masked_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_email is null or position('@' in p_email) < 2 then null
    else left(p_email, 1) || '***@' || split_part(p_email, '@', 2) end;
$$;
comment on function private.masked_email(text) is 'An email address shown to an advance link without its local part: the first letter, ***, then @ and the domain (R10). NULL for anything that is not an address.';
revoke all on function private.masked_email(text) from public, anon, authenticated;

-- How an advance link sees a person on its roster: their name once they accepted, else the invited address masked.
create or replace function private.advance_roster_display_name(p_roster_entry_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when rp.person_id is not null and (r.is_self or r.person_response = 'Accepted') then pe.full_name
    else private.masked_email((
      select i.email from app.roster_invitations i
      where i.roster_entry_id = r.id and i.deleted_at is null
      order by i.created_at desc, i.id desc limit 1))
  end
  from app.engagement_roster_entries r
  join private.roster_people rp on rp.roster_entry_id = r.id
  left join app.people pe on pe.id = rp.person_id
  where r.id = p_roster_entry_id;
$$;
comment on function private.advance_roster_display_name(uuid) is 'R10: the name an advance link shows for a roster entry: the person''s full name once they accepted the entry (the engaged person''s on the self entry), otherwise the latest invited address masked by private.masked_email, or NULL when there is neither.';
revoke all on function private.advance_roster_display_name(uuid) from public, anon, authenticated;

-- The open answer of a section for a recipient: its latest answer unless that was Returned.
create or replace function private.advance_answer_open(p_section_id uuid, p_recipient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from (
      select x.review_outcome from app.advance_submissions x
      where x.advance_section_id = p_section_id and x.advance_recipient_id = p_recipient_id and x.deleted_at is null
      order by x.submitted_at desc, x.id desc limit 1) a
    where a.review_outcome is null or a.review_outcome = 'Accepted');
$$;
comment on function private.advance_answer_open(uuid, uuid) is 'R10: true while the recipient''s latest answer to the section awaits review or was Accepted, so the section takes no new answer (advance_answer_pending, 2604 and 2711).';
revoke all on function private.advance_answer_open(uuid, uuid) from public, anon, authenticated;

-- 6. The packet through the link, from 0430 --------------------------------------------------------------------------------------

drop function api_public.preview_advance(text, text);

create function api_public.preview_advance(p_token text, p_access_code text)
returns table (
  refusal text,
  reason text,
  org_name text,
  packet_title text,
  due_at timestamptz,
  recipient_email text,
  expires_at timestamptz,
  section_id uuid,
  section_position integer,
  section_title text,
  section_prompt text,
  answer_body text,
  answered_at timestamptz,
  review_outcome app.advance_review_outcome,
  return_reason text,
  section_kind app.advance_section_kind,
  window_kind app.advance_window_kind,
  max_lines integer,
  per_person boolean,
  choices jsonb,
  answer_id uuid,
  answer_note text,
  answer_lines jsonb,
  answer_files jsonb,
  can_answer boolean,
  guest_cap integer,
  guests_used integer,
  roster_summary jsonb,
  project_time_zone text,
  roster_people jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_advance_token(p_token, p_access_code) r;
  if v_reason is not null then
    return query select 'REFUSE'::text, v_reason, null::text, null::text, null::timestamptz, null::text, null::timestamptz,
      null::uuid, null::integer, null::text, null::text, null::text, null::timestamptz, null::app.advance_review_outcome, null::text,
      null::app.advance_section_kind, null::app.advance_window_kind, null::integer, null::boolean, null::jsonb, null::uuid,
      null::text, null::jsonb, null::jsonb, null::boolean, null::integer, null::integer, null::jsonb, null::text, null::jsonb;
    return;
  end if;
  return query
    select null::text, null::text, o.name, p.title, p.due_at, t.recipient_email, t.expires_at,
      s.id, s.position, s.title, s.prompt, a.body, a.submitted_at, a.review_outcome, a.return_reason,
      s.section_kind, s.window_kind, s.max_lines::integer, s.per_person,
      case when s.section_kind in ('Item Request', 'Credential Request') then (
        select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'asset_class_id', c.asset_class_id, 'class_name', ac.name,
            'credential_category_id', c.credential_category_id, 'category_name', k.name) order by coalesce(ac.name, k.name), c.id), '[]'::jsonb)
        from app.advance_section_choices c
        left join app.asset_classes ac on ac.id = c.asset_class_id
        left join app.credential_categories k on k.id = c.credential_category_id
        where c.advance_section_id = s.id and c.deleted_at is null) end,
      a.id, a.note,
      case when a.id is not null then (
        select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('line_number', l.line_number,
            'asset_class_id', l.asset_class_id, 'credential_category_id', l.credential_category_id,
            'roster_entry_id', l.roster_entry_id, 'quantity', l.quantity,
            'needed_window_start', lower(l.needed_window), 'needed_window_end', upper(l.needed_window),
            'window_zone', l.window_zone, 'note', l.note)) order by l.line_number), '[]'::jsonb)
        from app.advance_submission_lines l where l.advance_submission_id = a.id) end,
      case when a.id is not null then (
        select coalesce(jsonb_agg(jsonb_build_object('file_id', f.document_id, 'title', d.title,
            'scan_status', coalesce(sc.scan_status::text, 'Scanning')) order by f.position), '[]'::jsonb)
        from app.advance_submission_files f
        join app.documents d on d.id = f.document_id
        left join lateral (
          select v.storage_uri from app.document_versions v where v.document_id = d.id order by v.created_at, v.id limit 1
        ) dv on true
        left join private.object_scans sc on sc.bucket_id = 'party-uploads'
          and sc.object_name = substr(dv.storage_uri, char_length('storage://party-uploads/') + 1)
        where f.advance_submission_id = a.id) end,
      s.section_kind <> 'Crew Roster' and not private.advance_answer_open(s.id, rc.id),
      case when s.section_kind = 'Guest List' and rc.engagement_id is not null then (
        select eo.cap_per_engagement from private.effective_offerings(rc.engagement_id) eo where eo.offering = 'Guest List') end,
      case when s.section_kind = 'Guest List' and rc.engagement_id is not null then (
        select coalesce(sum(1 + g.plus_ones), 0)::integer from app.guest_list_entries g
        where g.engagement_id = rc.engagement_id and g.deleted_at is null and g.entry_state <> 'Declined') end,
      case when s.section_kind = 'Crew Roster' and rc.engagement_id is not null then (
        select coalesce(jsonb_object_agg(x.entry_state, x.n), '{}'::jsonb) from (
          select r.entry_state::text as entry_state, count(*)::integer as n from app.engagement_roster_entries r
          where r.engagement_id = rc.engagement_id and r.deleted_at is null group by r.entry_state) x) end,
      pr.time_zone,
      case when s.section_kind in ('Item Request', 'Credential Request') and rc.engagement_id is not null then (
        select coalesce(jsonb_agg(jsonb_build_object('roster_entry_id', r.id, 'display_name', private.advance_roster_display_name(r.id))
            order by r.created_at, r.id), '[]'::jsonb)
        from app.engagement_roster_entries r
        where r.engagement_id = rc.engagement_id and r.deleted_at is null and r.entry_state in ('Draft', 'Submitted', 'Accepted')
          and r.person_response <> 'Declined') end
    from app.advance_recipient_tokens t
    join app.advance_recipients rc on rc.id = t.advance_recipient_id
    join app.advance_packets p on p.id = rc.advance_packet_id
    join app.organizations o on o.id = p.org_id
    join app.projects pr on pr.id = p.project_id
    join app.advance_sections s on s.advance_packet_id = p.id and s.deleted_at is null
    left join lateral (
      select x.id, x.body, x.note, x.submitted_at, x.review_outcome, x.return_reason from app.advance_submissions x
      where x.advance_section_id = s.id and x.advance_recipient_id = rc.id and x.deleted_at is null
      order by x.submitted_at desc, x.id desc limit 1
    ) a on true
    where t.id = v_token_id
    order by s.position;
end;
$$;
comment on function api_public.preview_advance(text, text) is 'Gateway advance form without an account (Section 4.4.6): with a valid token and access code, returns one row per section of the packet with the recipient''s latest answer and its review. R10 appends, after return_reason: the section''s kind, window kind, most lines and per-person flag; its choices [{id, asset_class_id, class_name, credential_category_id, category_name}]; the latest answer''s id, note, lines and files [{file_id, title, scan_status}]; can_answer (false for a Crew Roster section and while the latest answer awaits review or was Accepted); for a Guest List the engagement''s cap and the guests used, plus-ones counted; for a Crew Roster the roster''s counts by entry state; the project''s time zone; and for an Item or Credential Request the roster people a line may name [{roster_entry_id, display_name}], each a name once accepted and a masked email otherwise. Otherwise one row with refusal REFUSE and the reason: advance_token_invalid, advance_token_locked, advance_access_code or advance_token_expired.';
revoke all on function api_public.preview_advance(text, text) from public;
grant execute on function api_public.preview_advance(text, text) to anon, authenticated, service_role;

-- 7. A typed answer through the link -------------------------------------------------------------------------------------------

create or replace function api_public.submit_advance_typed(
  p_token text,
  p_access_code text,
  p_section_id uuid,
  p_text text,
  p_note text,
  p_lines jsonb,
  p_document_ids uuid[]
)
returns table (submission_id uuid, submitted_at timestamptz, refusal text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
  v_recipient uuid;
  v_id uuid;
  v_at timestamptz;
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_advance_token(p_token, p_access_code) r;
  if v_reason is not null then
    return query select null::uuid, null::timestamptz, 'REFUSE'::text, v_reason;
    return;
  end if;
  select t.advance_recipient_id into v_recipient from app.advance_recipient_tokens t where t.id = v_token_id;
  if not exists (select 1 from app.advance_sections s join app.advance_recipients r on r.advance_packet_id = s.advance_packet_id
                 where s.id = p_section_id and s.deleted_at is null and r.id = v_recipient) then
    return query select null::uuid, null::timestamptz, 'REFUSE'::text, 'advance_section_open'::text;
    return;
  end if;
  begin
    v_id := private.record_advance_answer(v_recipient, p_section_id, p_text, p_note, p_lines, p_document_ids, v_token_id);
  exception when sqlstate 'XR001' then
    get stacked diagnostics v_reason = pg_exception_hint;
    return query select null::uuid, null::timestamptz, 'REFUSE'::text, v_reason;
    return;
  end;
  select x.submitted_at into v_at from app.advance_submissions x where x.id = v_id;
  update app.advance_recipient_tokens t set used_at = coalesce(t.used_at, v_at) where t.id = v_token_id;
  return query select v_id, v_at, null::text, null::text;
end;
$$;
comment on function api_public.submit_advance_typed(text, text, uuid, text, text, jsonb, uuid[]) is 'Gateway advance form without an account (R10): with a valid token and access code, answers one section of any kind of the recipient''s packet through private.record_advance_answer, as app.submit_advance_answer does signed in: one open answer per section (advance_answer_pending), the line and file rules of R9, and Requested allocations for item and credential lines, whose requester is the person who later claims the link. p_document_ids are documents from api_public.finish_advance_upload. Marks the link used. Refusals come back as REFUSE with a reason: the token reasons of preview_advance, advance_section_open, or the rule private.record_advance_answer refused.';
revoke all on function api_public.submit_advance_typed(text, text, uuid, text, text, jsonb, uuid[]) from public;
grant execute on function api_public.submit_advance_typed(text, text, uuid, text, text, jsonb, uuid[]) to anon, authenticated, service_role;

-- 8. Uploads through the link -------------------------------------------------------------------------------------------------

create or replace function api_public.begin_advance_upload(
  p_token text,
  p_access_code text,
  p_section_id uuid,
  p_file_name text,
  p_content_type text,
  p_byte_size integer
)
returns table (ticket_id uuid, object_name text, expires_at timestamptz, refusal text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
  v_recipient app.advance_recipients;
  v_section app.advance_sections;
  v_id uuid := gen_random_uuid();
  v_name text;
  v_safe text;
  v_expires timestamptz := now() + interval '15 minutes';
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_advance_token(p_token, p_access_code) r;
  if v_reason is not null then
    return query select null::uuid, null::text, null::timestamptz, 'REFUSE'::text, v_reason;
    return;
  end if;
  select r.* into v_recipient from app.advance_recipient_tokens t join app.advance_recipients r on r.id = t.advance_recipient_id
  where t.id = v_token_id;
  select s.* into v_section from app.advance_sections s
  where s.id = p_section_id and s.deleted_at is null and s.advance_packet_id = v_recipient.advance_packet_id;
  if v_section.id is null or v_section.section_kind <> 'File' then
    return query select null::uuid, null::text, null::timestamptz, 'REFUSE'::text, 'advance_section_open'::text;
    return;
  end if;
  if private.advance_answer_open(v_section.id, v_recipient.id) then
    return query select null::uuid, null::text, null::timestamptz, 'REFUSE'::text, 'advance_answer_pending'::text;
    return;
  end if;
  if p_content_type is null or not exists (
      select 1 from storage.buckets b where b.id = 'party-uploads' and p_content_type = any (b.allowed_mime_types)) then
    return query select null::uuid, null::text, null::timestamptz, 'REFUSE'::text, 'advance_upload_type'::text;
    return;
  end if;
  if p_byte_size is null or p_byte_size not between 1 and 26214400 then
    return query select null::uuid, null::text, null::timestamptz, 'REFUSE'::text, 'advance_upload_size'::text;
    return;
  end if;
  -- Open tickets and uploaded files not yet in an answer count toward the section's files.
  if (select count(*) from private.advance_upload_tickets k
      where k.advance_recipient_token_id = v_token_id and k.advance_section_id = v_section.id
        and ((k.used_at is null and k.expires_at > now())
          or (k.document_id is not null and not exists (select 1 from app.advance_submission_files f where f.document_id = k.document_id))))
     >= v_section.max_lines then
    return query select null::uuid, null::text, null::timestamptz, 'REFUSE'::text, 'advance_upload_limit'::text;
    return;
  end if;
  if private.rate_limit_exceeded('advance_token_upload', v_token_id::text, 20, interval '1 hour') then
    return query select null::uuid, null::text, null::timestamptz, 'REFUSE'::text, 'advance_upload_rate'::text;
    return;
  end if;
  -- The file name is cleaned as packages/data onboardingObjectName does.
  v_safe := left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._-]+', '-', 'g'), '-'), 120);
  v_name := format('%s/advance-token/%s/%s', v_recipient.org_id, v_id, coalesce(nullif(v_safe, ''), 'upload'));
  insert into private.advance_upload_tickets (id, org_id, advance_recipient_token_id, advance_section_id, object_name,
    content_type, byte_size, expires_at)
  values (v_id, v_recipient.org_id, v_token_id, v_section.id, v_name, p_content_type, p_byte_size, v_expires);
  perform private.note_rate_event('advance_token_upload', v_token_id::text);
  return query select v_id, v_name, v_expires, null::text, null::text;
end;
$$;
comment on function api_public.begin_advance_upload(text, text, uuid, text, text, integer) is 'Gateway advance form without an account (R10): with a valid token and access code, issues an upload ticket for a File section of the recipient''s packet, open for 15 minutes, for one object <org_id>/advance-token/<ticket id>/<file name>, the name cleaned to letters, digits, dot, underscore and hyphen. Refusals come back as REFUSE with a reason: the token reasons of preview_advance; advance_section_open (not a File section of the packet); advance_answer_pending while the section''s answer awaits review or was Accepted; advance_upload_type (a type party-uploads does not take); advance_upload_size (over 25 MB); advance_upload_limit (open tickets and unattached files reach the section''s most files); advance_upload_rate (20 tickets per link per hour).';
revoke all on function api_public.begin_advance_upload(text, text, uuid, text, text, integer) from public;
grant execute on function api_public.begin_advance_upload(text, text, uuid, text, text, integer) to anon, authenticated, service_role;

create or replace function api_public.finish_advance_upload(
  p_token text,
  p_access_code text,
  p_ticket_id uuid,
  p_title text,
  p_checksum_sha256 text
)
returns table (document_id uuid, refusal text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
  v_ticket private.advance_upload_tickets;
  v_project uuid;
  v_object storage.objects;
  v_title text;
  v_document uuid;
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_advance_token(p_token, p_access_code) r;
  if v_reason is not null then
    return query select null::uuid, 'REFUSE'::text, v_reason;
    return;
  end if;
  select k.* into v_ticket from private.advance_upload_tickets k
  where k.id = p_ticket_id and k.advance_recipient_token_id = v_token_id for update;
  if v_ticket.id is null or v_ticket.used_at is not null then
    return query select null::uuid, 'REFUSE'::text, 'advance_upload_ticket'::text;
    return;
  end if;
  select o.* into v_object from storage.objects o where o.bucket_id = 'party-uploads' and o.name = v_ticket.object_name;
  if v_object.id is null then
    return query select null::uuid, 'REFUSE'::text, 'party_upload_missing'::text;
    return;
  end if;
  if p_checksum_sha256 is null or p_checksum_sha256 !~ '^[0-9a-f]{64}$' then
    return query select null::uuid, 'REFUSE'::text, 'party_upload_checksum'::text;
    return;
  end if;
  -- The stored object must be what the ticket declared.
  if v_object.metadata ->> 'mimetype' is distinct from null and v_object.metadata ->> 'mimetype' <> v_ticket.content_type then
    return query select null::uuid, 'REFUSE'::text, 'advance_upload_type'::text;
    return;
  end if;
  if (v_object.metadata ->> 'size') ~ '^[0-9]+$' and (v_object.metadata ->> 'size')::bigint > v_ticket.byte_size then
    return query select null::uuid, 'REFUSE'::text, 'advance_upload_size'::text;
    return;
  end if;
  select p.project_id into v_project from app.advance_sections s join app.advance_packets p on p.id = s.advance_packet_id
  where s.id = v_ticket.advance_section_id;
  v_title := coalesce(nullif(left(btrim(coalesce(p_title, '')), 200), ''), split_part(v_ticket.object_name, '/', 4));
  insert into app.documents (org_id, project_id, title) values (v_ticket.org_id, v_project, v_title)
  returning id into v_document;
  insert into app.document_versions (document_id, storage_uri, checksum_sha256)
  values (v_document, 'storage://party-uploads/' || v_ticket.object_name, p_checksum_sha256);
  update private.advance_upload_tickets k set document_id = v_document, used_at = now() where k.id = v_ticket.id;
  return query select v_document, null::text, null::text;
end;
$$;
comment on function api_public.finish_advance_upload(text, text, uuid, text, text) is 'Gateway advance form without an account (R10): with a valid token and access code, registers the object of one of the link''s unused tickets (advance_upload_ticket otherwise; an expired ticket still finishes an object stored while it was open) as a document of the packet''s project with its first version at storage://party-uploads/<name>, and marks the ticket used. The object must exist (party_upload_missing), match the declared type and size (advance_upload_type, advance_upload_size), and the checksum be a lowercase SHA-256 (party_upload_checksum). The scan queue already holds the object; api_public.submit_advance_typed then attaches the document. Returns the document id.';
revoke all on function api_public.finish_advance_upload(text, text, uuid, text, text) from public;
grant execute on function api_public.finish_advance_upload(text, text, uuid, text, text) to anon, authenticated, service_role;
