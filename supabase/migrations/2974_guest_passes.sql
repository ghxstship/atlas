-- 2974_guest_passes.sql
-- B8 Guest passes (RRR-232, gap G-68, ADR 0147 decision 6). Guests get passes, not credentials:
--
--   * app.guest_list_entries gains the pass type (an Access category of the same project, such as GUEST or VIP), a
--     table or seat, a host (a project person: a current member of the project's org or the person on a live
--     engagement of the project, as app.project_people lists them, 2600), the guest's email for their pass (2975), and
--     a pass code GP- plus 10 random base32 characters that the database stamps when the guest is approved. The guest
--     pass document prints it as the scan payload XOSGP1:<pass code>.
--   * private.guard_guest_list_entry (from P3 2802) keeps every rule and adds: a party (the trusted operation
--     request_engaged_guest) never sets the pass type, table or host (guest_entry_production_fields); those and the
--     email change in any state except Checked In (guest_entry_checked_in); the pass code is stamped on insert as
--     Approved or on the move from Requested to Approved, kept on Checked In, and never written by a caller
--     (guest_entry_stamped). Declined is reachable only from Requested, which has no code.
--   * app.request_engaged_guest (from R9 2715) and api_public.request_advance_guest (from R10 2731) take the guest's
--     email (guest_email_format before the insert, so the table check never surfaces as a raw 23514).
--   * app.door_guest_list (from 0806) returns the pass and finds a guest by the exact pass code; app.check_in_guest
--     (from 0806) tells the host their guest arrived (guest.arrived), unless the host checked them in.
--   * The import worker (P3) fills guest_email and table_label.

-- Columns ---------------------------------------------------------------------------------------------------------------

alter table app.guest_list_entries
  add column pass_category_id uuid references app.credential_categories (id),
  add column table_label text,
  add column host_person_id uuid references app.people (id),
  add column guest_email text,
  add column pass_code text,
  add constraint guest_list_entries_table_label_length check (table_label is null or char_length(btrim(table_label)) between 1 and 40),
  add constraint guest_list_entries_guest_email check (guest_email is null or (guest_email = lower(guest_email)
    and guest_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(guest_email) <= 320)),
  add constraint guest_list_entries_pass_code_format check (pass_code is null or pass_code ~ '^GP-[A-Z2-7]{10}$');

create index guest_list_entries_pass_category_id_idx on app.guest_list_entries (pass_category_id);
create index guest_list_entries_host_person_id_idx on app.guest_list_entries (host_person_id);
create unique index guest_list_entries_pass_code_key on app.guest_list_entries (org_id, pass_code) where pass_code is not null;

comment on column app.guest_list_entries.pass_category_id is 'Pass type: an Access credential category of the same project, such as GUEST or VIP. Set by the production, never by a party.';
comment on column app.guest_list_entries.table_label is 'Table or seat, 1 to 40 characters. Set by the production.';
comment on column app.guest_list_entries.host_person_id is 'Project person hosting the guest: a current member of the org or the person on a live engagement of the project. Told when the guest arrives.';
comment on column app.guest_list_entries.guest_email is 'Lowercased email address the guest''s pass and messages go to. Confidential.';
comment on column app.guest_list_entries.pass_code is 'Pass code GP- and 10 random base32 characters, unique in the org, stamped by the database when the guest is approved; the pass prints it as XOSGP1:<code>.';

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.guest_list_entries', 'guest_email', 'Confidential', null);

create trigger t39_guest_list_pass_project before insert or update of pass_category_id, project_id on app.guest_list_entries
  for each row execute function private.assert_same_project('app.credential_categories', 'pass_category_id');

-- Helpers -----------------------------------------------------------------------------------------------------------------

create function private.is_project_person(p_project_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from app.memberships m
      join app.projects p on p.org_id = m.org_id
      where p.id = p_project_id and m.person_id = p_person_id and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
    or exists (
      select 1 from app.engagements e
      where e.project_id = p_project_id and e.person_id = p_person_id and e.deleted_at is null
        and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing'));
$$;
comment on function private.is_project_person(uuid, uuid) is 'True when the person is one app.project_people lists for the project (2600): a current member of its org, or the person on a live engagement of it.';
revoke all on function private.is_project_person(uuid, uuid) from public, anon, authenticated;

create function private.new_guest_pass_code(p_org_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_bytes bytea;
  v_code text;
  i integer;
begin
  loop
    v_bytes := extensions.gen_random_bytes(10);
    v_code := 'GP-';
    for i in 0..9 loop
      v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
    end loop;
    -- The stamp runs in a before trigger, where a unique violation cannot be caught and retried, so the drawn code is
    -- locked first: a concurrent approval that drew the same code waits here, then sees the committed row and draws again.
    perform pg_advisory_xact_lock(hashtextextended('guest_pass_code:' || p_org_id || ':' || v_code, 0));
    exit when not exists (select 1 from app.guest_list_entries g where g.org_id = p_org_id and g.pass_code = v_code);
  end loop;
  return v_code;
end;
$$;
comment on function private.new_guest_pass_code(uuid) is 'A guest pass code unused in the org: GP- and 10 base32 characters (A to Z, 2 to 7) from 10 random bytes, drawn again until it is free. Each drawn code is held with a transaction advisory lock before it is checked, so two concurrent approvals never stamp the same code and the unique index never surfaces as a raw 23505.';
revoke all on function private.new_guest_pass_code(uuid) from public, anon, authenticated;

create function private.normalize_guest_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(lower(btrim(coalesce(p_email, ''))), '');
$$;
comment on function private.normalize_guest_email(text) is 'A guest email as stored: trimmed and lowercased, NULL when empty.';
revoke all on function private.normalize_guest_email(text) from public, anon, authenticated;

create function private.guest_email_valid(p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_email is null or (p_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(p_email) <= 320);
$$;
comment on function private.guest_email_valid(text) is 'True for NULL or a normalized address the guest_list_entries_guest_email check accepts.';
revoke all on function private.guest_email_valid(text) from public, anon, authenticated;

-- The guest list guard (from P3 2802) -------------------------------------------------------------------------------------

create or replace function private.guard_guest_list_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_trusted boolean := private.in_trusted_operation('request_engaged_guest');
begin
  if new.pass_category_id is not null and (tg_op = 'INSERT' or new.pass_category_id is distinct from old.pass_category_id)
     and coalesce((select c.category_kind::text from app.credential_categories c
                   where c.id = new.pass_category_id and c.deleted_at is null), '') <> 'Access' then
    perform private.refuse('guest_pass_category', 'A pass type is an Access credential category of this project.');
  end if;
  if new.host_person_id is not null and (tg_op = 'INSERT' or new.host_person_id is distinct from old.host_person_id)
     and not private.is_project_person(new.project_id, new.host_person_id) then
    perform private.refuse('guest_host_not_on_project', 'A host is a member of the organization or engaged on this project.');
  end if;

  if tg_op = 'INSERT' then
    if new.decided_at is not null or new.decided_by is not null or new.checked_in_at is not null or new.checked_in_by is not null
       or new.pass_code is not null then
      perform private.refuse('guest_entry_stamped', 'Decision and check-in times are set by the database.');
    end if;
    if v_trusted and (new.pass_category_id is not null or new.table_label is not null or new.host_person_id is not null) then
      perform private.refuse('guest_entry_production_fields', 'The pass type, table and host are set by the production.');
    end if;
    if new.entry_state = 'Checked In' or new.entry_state = 'Declined' then
      perform private.refuse('guest_entry_state', 'A guest is added as Requested, or as Approved by a reviewer.');
    end if;
    if new.entry_state = 'Approved' then
      if v_trusted or not private.can_on_project(new.project_id, 'advancing.submission.review') then
        perform private.refuse('guest_entry_authority', 'Approving guests needs advancing.submission.review on the project.');
      end if;
      new.decided_at := now();
      new.decided_by := v_person;
      new.pass_code := private.new_guest_pass_code(new.org_id);
    end if;
    return new;
  end if;

  if new.pass_code is distinct from old.pass_code then
    perform private.refuse('guest_entry_stamped', 'Decision and check-in times are set by the database.');
  end if;
  if old.entry_state <> 'Requested' and (new.guest_name is distinct from old.guest_name or new.plus_ones is distinct from old.plus_ones
     or new.person_id is distinct from old.person_id or new.counterparty_id is distinct from old.counterparty_id
     or new.scope_node_id is distinct from old.scope_node_id) then
    perform private.refuse('guest_entry_decided', 'A decided guest keeps its name, plus-ones, party and show; decline it and request again.');
  end if;
  if old.entry_state = 'Checked In' and (new.pass_category_id is distinct from old.pass_category_id
     or new.table_label is distinct from old.table_label or new.host_person_id is distinct from old.host_person_id
     or new.guest_email is distinct from old.guest_email) then
    perform private.refuse('guest_entry_checked_in', 'A checked-in guest keeps their pass type, table, host and email.');
  end if;
  if new.decided_at is distinct from old.decided_at or new.decided_by is distinct from old.decided_by
     or new.checked_in_at is distinct from old.checked_in_at or new.checked_in_by is distinct from old.checked_in_by then
    if new.entry_state is not distinct from old.entry_state then
      perform private.refuse('guest_entry_stamped', 'Decision and check-in times are set by the database.');
    end if;
  end if;
  if new.entry_state is distinct from old.entry_state then
    if old.entry_state = 'Requested' and new.entry_state in ('Approved', 'Declined') then
      if not private.can_on_project(new.project_id, 'advancing.submission.review') then
        perform private.refuse('guest_entry_authority', 'Approving or declining guests needs advancing.submission.review on the project.');
      end if;
      if v_person is not null and (v_person = old.created_by
         or (old.created_by is null and private.is_import_requester('app.guest_list_entries', old.id, v_person))) then
        perform private.refuse('sod_guest_requester', 'The person who requested a guest cannot approve or decline the request.');
      end if;
      new.decided_at := now();
      new.decided_by := v_person;
      new.checked_in_at := null;
      new.checked_in_by := null;
      if new.entry_state = 'Approved' then
        new.pass_code := private.new_guest_pass_code(new.org_id);
      end if;
    elsif old.entry_state = 'Approved' and new.entry_state = 'Checked In' then
      new.decided_at := old.decided_at;
      new.decided_by := old.decided_by;
      new.checked_in_at := now();
      new.checked_in_by := v_person;
    else
      perform private.refuse('guest_entry_transition', format('A guest moves from %s only as the guest list allows.', old.entry_state));
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_guest_list_entry() is 'Guest list state machine: Requested to Approved or Declined (review authority, never the requester: for an imported guest, neither the person who created the import nor the one who committed it), Approved to Checked In; the database stamps who and when, and the pass code on approval (B8); a decided entry keeps its guest. The pass type is an Access category of the project (guest_pass_category) and the host a project person (guest_host_not_on_project); a party never sets them or the table (guest_entry_production_fields); they and the email are fixed once the guest is checked in (guest_entry_checked_in).';
revoke all on function private.guard_guest_list_entry() from public, anon, authenticated;

-- A party's request (from R9 2715) ---------------------------------------------------------------------------------------

drop function app.request_engaged_guest(uuid, text, integer, text, uuid);

create function app.request_engaged_guest(
  p_engagement_id uuid,
  p_guest_name text,
  p_plus_ones integer default 0,
  p_note text default null,
  p_scope_node_id uuid default null,
  p_guest_email text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_email text := private.normalize_guest_email(p_guest_email);
  v_id uuid;
begin
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null or not private.guest_party_open(v_engagement.project_id, v_engagement.person_id, v_engagement.counterparty_id) then
    raise exception using errcode = '42501', message = 'engagement not found';
  end if;
  if not private.guest_email_valid(v_email) then
    perform private.refuse('guest_email_format', 'Enter one email address for the guest, or leave it empty.');
  end if;
  perform private.assert_guest_capacity(v_engagement.id, coalesce(p_plus_ones, 0));
  perform private.begin_trusted_operation('request_engaged_guest');
  insert into app.guest_list_entries (project_id, scope_node_id, person_id, counterparty_id, engagement_id, guest_name, plus_ones, note,
    guest_email)
  values (v_engagement.project_id, p_scope_node_id,
          v_engagement.person_id, case when v_engagement.person_id is null then v_engagement.counterparty_id end,
          v_engagement.id, btrim(coalesce(p_guest_name, '')), coalesce(p_plus_ones, 0), nullif(btrim(p_note), ''), v_email)
  returning id into v_id;
  perform private.end_trusted_operation('request_engaged_guest');
  return v_id;
end;
$$;
comment on function app.request_engaged_guest(uuid, text, integer, text, uuid, text) is 'Gateway Guest List: the engaged person, their Advance representative or the engaged account requests a guest (Requested) on the engagement''s project while its operational area is open, while the Guest List offering is offered (offering_not_offered) and within the engagement''s cap counted with plus-ones (guest_list_cap, R9), optionally with the guest''s email for their pass (guest_email_format, B8). The production sets the pass type, table and host, and approves or declines in Atlas. Returns the entry id.';
revoke all on function app.request_engaged_guest(uuid, text, integer, text, uuid, text) from public, anon;
grant execute on function app.request_engaged_guest(uuid, text, integer, text, uuid, text) to authenticated, service_role;

-- A party's request through an advance link (from R10 2731) ---------------------------------------------------------------

drop function api_public.request_advance_guest(text, text, uuid, text, integer, text);

create function api_public.request_advance_guest(
  p_token text,
  p_access_code text,
  p_section_id uuid,
  p_guest_name text,
  p_plus_ones integer,
  p_note text,
  p_guest_email text default null
)
returns table (guest_entry_id uuid, refusal text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
  v_recipient app.advance_recipients;
  v_engagement app.engagements;
  v_name text := btrim(coalesce(p_guest_name, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_plus integer := coalesce(p_plus_ones, 0);
  v_email text := private.normalize_guest_email(p_guest_email);
  v_id uuid;
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_advance_token(p_token, p_access_code) r;
  if v_reason is not null then
    return query select null::uuid, 'REFUSE'::text, v_reason;
    return;
  end if;
  select r.* into v_recipient from app.advance_recipient_tokens t join app.advance_recipients r on r.id = t.advance_recipient_id
  where t.id = v_token_id;
  if not exists (select 1 from app.advance_sections s
                 where s.id = p_section_id and s.deleted_at is null and s.advance_packet_id = v_recipient.advance_packet_id
                   and s.section_kind = 'Guest List') then
    return query select null::uuid, 'REFUSE'::text, 'advance_section_open'::text;
    return;
  end if;
  select e.* into v_engagement from app.engagements e where e.id = v_recipient.engagement_id and e.deleted_at is null;
  if v_engagement.id is null then
    return query select null::uuid, 'REFUSE'::text, 'advance_recipient_engagement'::text;
    return;
  end if;
  if v_engagement.role_type in ('Contractor', 'Sponsor') then
    return query select null::uuid, 'REFUSE'::text, 'advance_section_role'::text;
    return;
  end if;
  if v_engagement.engagement_state not in ('Active', 'Closing') then
    return query select null::uuid, 'REFUSE'::text, 'guest_list_closed'::text;
    return;
  end if;
  if char_length(v_name) not between 1 and 200 then
    return query select null::uuid, 'REFUSE'::text, 'guest_name_length'::text;
    return;
  end if;
  if v_plus not between 0 and 20 then
    return query select null::uuid, 'REFUSE'::text, 'guest_plus_ones'::text;
    return;
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    return query select null::uuid, 'REFUSE'::text, 'guest_note_length'::text;
    return;
  end if;
  if not private.guest_email_valid(v_email) then
    return query select null::uuid, 'REFUSE'::text, 'guest_email_format'::text;
    return;
  end if;
  if private.rate_limit_exceeded('advance_token_guest', v_token_id::text, 50, interval '1 day') then
    return query select null::uuid, 'REFUSE'::text, 'advance_guest_rate'::text;
    return;
  end if;
  begin
    perform private.assert_guest_capacity(v_engagement.id, v_plus);
    perform private.begin_trusted_operation('request_engaged_guest');
    insert into app.guest_list_entries (project_id, person_id, counterparty_id, engagement_id, guest_name, plus_ones, note, guest_email)
    values (v_engagement.project_id, v_engagement.person_id,
            case when v_engagement.person_id is null then v_engagement.counterparty_id end,
            v_engagement.id, v_name, v_plus, v_note, v_email)
    returning id into v_id;
    perform private.end_trusted_operation('request_engaged_guest');
  exception when sqlstate 'XR001' then
    get stacked diagnostics v_reason = pg_exception_hint;
    return query select null::uuid, 'REFUSE'::text, v_reason;
    return;
  end;
  perform private.note_rate_event('advance_token_guest', v_token_id::text);
  return query select v_id, null::text, null::text;
end;
$$;
comment on function api_public.request_advance_guest(text, text, uuid, text, integer, text, text) is 'Gateway advance form without an account (R10): with a valid token and access code, asks for a guest (Requested) on a Guest List section of the recipient''s packet, for the recipient''s engagement, as app.request_engaged_guest does signed in, optionally with the guest''s email for their pass (B8); the production approves or declines in Atlas. Refusals come back as REFUSE with a reason: the token reasons of preview_advance; advance_section_open (not a Guest List of the packet); advance_recipient_engagement (no engagement); advance_section_role (a contractor or sponsor); guest_list_closed (the engagement is not Active or Closing); guest_name_length, guest_plus_ones, guest_note_length, guest_email_format; offering_not_offered and guest_list_cap (private.assert_guest_capacity); advance_guest_rate (50 per link per day). Returns the guest entry id.';
revoke all on function api_public.request_advance_guest(text, text, uuid, text, integer, text, text) from public;
grant execute on function api_public.request_advance_guest(text, text, uuid, text, integer, text, text) to anon, authenticated, service_role;

-- The door list (from 0806, its only definition) ------------------------------------------------------------------------

drop function app.door_guest_list(uuid, text);

create function app.door_guest_list(p_project_id uuid, p_search text default null)
returns table (
  guest_list_entry_id uuid,
  guest_name text,
  plus_ones smallint,
  entry_state app.guest_entry_state,
  note text,
  checked_in_at timestamptz,
  plus_ones_admitted smallint,
  door text,
  pass_code text,
  pass_category_code text,
  pass_category_name text,
  table_label text,
  host_person_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if not private.can_on_project(p_project_id, 'credentials.scan.write') then
    raise exception using errcode = '42501', message = 'the door list needs credentials.scan.write on the project';
  end if;
  return query
    select g.id, g.guest_name, g.plus_ones, g.entry_state, g.note, g.checked_in_at, c.plus_ones_admitted, c.door,
      g.pass_code, k.code, k.name, g.table_label, g.host_person_id
    from app.guest_list_entries g
    left join app.guest_check_ins c on c.guest_list_entry_id = g.id
    left join app.credential_categories k on k.id = g.pass_category_id
    where g.project_id = p_project_id and g.deleted_at is null and g.entry_state in ('Approved', 'Checked In')
      and (coalesce(btrim(p_search), '') = '' or g.guest_name ilike '%' || btrim(p_search) || '%'
           or g.pass_code = upper(btrim(p_search)))
    order by g.entry_state, g.guest_name;
end;
$$;
comment on function app.door_guest_list(uuid, text) is 'The door list of a project for door staff (credentials.scan.write): approved and checked-in guests with plus-ones, pass type, table and host, filtered by name or found by the exact pass code.';
revoke all on function app.door_guest_list(uuid, text) from public, anon;
grant execute on function app.door_guest_list(uuid, text) to authenticated, service_role;

-- Check-in tells the host (from 0806, its only definition) ----------------------------------------------------------------

create or replace function app.check_in_guest(
  p_guest_list_entry_id uuid,
  p_plus_ones_admitted smallint default 0,
  p_door text default null,
  p_credential_number text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry app.guest_list_entries;
  v_credential app.credentials;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_entry from app.guest_list_entries g where g.id = p_guest_list_entry_id and g.deleted_at is null for update;
  if v_entry.id is null or not private.can_on_project(v_entry.project_id, 'credentials.scan.write') then
    raise exception using errcode = '42501', message = 'checking in guests needs credentials.scan.write on the project';
  end if;
  if v_entry.entry_state = 'Checked In' then
    perform private.refuse('guest_already_checked_in', 'This guest is already checked in.');
  end if;
  if v_entry.entry_state <> 'Approved' then
    perform private.refuse('guest_not_approved', 'Only approved guests are checked in; ask the guest list owner.');
  end if;
  if coalesce(p_plus_ones_admitted, 0) > v_entry.plus_ones then
    perform private.refuse('guest_plus_ones_exceeded', format('This guest has %s plus-ones on the list.', v_entry.plus_ones));
  end if;
  if coalesce(btrim(p_credential_number), '') <> '' then
    select * into v_credential from app.credentials c
    where c.org_id = v_entry.org_id and c.credential_number = btrim(p_credential_number) and c.project_id = v_entry.project_id and c.deleted_at is null;
    if v_credential.id is null or v_credential.revoked_at is not null or v_credential.valid_from > now()
       or (v_credential.valid_to is not null and v_credential.valid_to <= now()) then
      perform private.refuse('guest_credential_invalid', 'That credential is not valid for this project now.');
    end if;
    if v_entry.person_id is not null and v_credential.holder_person_id <> v_entry.person_id then
      perform private.refuse('guest_credential_holder', 'That credential belongs to someone else.');
    end if;
  end if;
  update app.guest_list_entries set entry_state = 'Checked In' where id = p_guest_list_entry_id;
  insert into app.guest_check_ins (guest_list_entry_id, plus_ones_admitted, credential_id, door, checked_in_by_membership_id)
  values (p_guest_list_entry_id, coalesce(p_plus_ones_admitted, 0), v_credential.id, nullif(btrim(p_door), ''),
    private.my_membership_in(v_entry.org_id))
  returning id into v_id;
  perform private.emit_event(v_entry.org_id, 'guest.checked_in_at_door', 'guest_check_ins', v_id, v_entry.project_id,
    jsonb_build_object('plus_ones_admitted', coalesce(p_plus_ones_admitted, 0), 'credential_scanned', v_credential.id is not null));
  if v_entry.host_person_id is not null and v_entry.host_person_id is distinct from private.current_person_id() then
    perform private.notify(v_entry.org_id, v_entry.host_person_id, 'guest.arrived', 'app.guest_list_entries', v_entry.id,
      v_entry.project_id, jsonb_build_object('guest_name', v_entry.guest_name, 'plus_ones_admitted', coalesce(p_plus_ones_admitted, 0),
        'door', coalesce(nullif(btrim(p_door), ''), ''), 'has_door', case when nullif(btrim(p_door), '') is null then 'no' else 'yes' end,
        'table_label', coalesce(v_entry.table_label, ''), 'has_table', case when v_entry.table_label is null then 'no' else 'yes' end));
  end if;
  return v_id;
end;
$$;
comment on function app.check_in_guest(uuid, smallint, text, text) is 'Checks an approved guest in at a door (credentials.scan.write on the project) with up to their listed plus-ones and an optional credential scan, which must be valid now, on the project and the guest''s own. Tells the guest''s host (guest.arrived), unless the host is the one checking them in. Returns the check-in id.';
revoke all on function app.check_in_guest(uuid, smallint, text, text) from public, anon;
grant execute on function app.check_in_guest(uuid, smallint, text, text) to authenticated, service_role;

-- Import fields (P3) -----------------------------------------------------------------------------------------------------

insert into private.import_target_fields (target_code, field_name, required, strong_key) values
  ('guest_list_entries', 'guest_email', false, false),
  ('guest_list_entries', 'table_label', false, false);
