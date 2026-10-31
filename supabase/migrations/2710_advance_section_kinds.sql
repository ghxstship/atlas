-- 2710_advance_section_kinds.sql
-- R9 Typed advance sections (RRR-189, ADR 0100 and 0104; owner decisions 4, 6, 7 and 8). The Advance tab stops being
-- free text only: a section has one of seven kinds, and what it asks for is configured on the section.
--
--   1. Enums app.advance_section_kind, app.advance_window_kind and app.sponsor_asset_source.
--   2. app.advance_sections gains section_kind (Text by default, so every existing section stays Text), window_kind,
--      max_lines and per_person, held to the kind by advance_sections_kind_fields. There is no offering column: an
--      Item Request names asset classes, and the offering is the class's own (R7's asset_classes.offering), checked
--      per answer line.
--   3. app.advance_section_choices: the asset classes an Item Request offers and the credential categories a
--      Credential Request offers, one target per row, fixed once the packet is sent.
--   4. private.guard_advance_section (from 0430): the kind and its configuration are fixed after send like the section
--      list; the title and prompt can still be corrected.
--   5. app.send_advance_packet (from 0430): refuses advance_section_choices_missing while an Item Request or Credential
--      Request section has no live choice.
--   6. app.advance_recipients.engagement_id: the engagement a recipient answers under, checked against the party
--      binding of 0351 and fixed after send; backfilled where exactly one live engagement matches.
--   7. app.sponsor_assets.asset_source: Org Supplied or Sponsor Supplied, fixed at insert.

-- 1. Vocabularies ------------------------------------------------------------------------------------------------------

create type app.advance_section_kind as enum (
  'Text', 'File', 'Schedule Window', 'Item Request', 'Crew Roster', 'Guest List', 'Credential Request'
);
comment on type app.advance_section_kind is 'What an advance section asks for (R9): free Text, File uploads, a Schedule Window, an Item Request of asset classes, the Crew Roster (read from the engagement''s roster, never answered), a Guest List confirmation, or a Credential Request of credential categories.';

create type app.advance_window_kind as enum (
  'Load In', 'Load Out', 'Arrival', 'Soundcheck', 'Activation Setup', 'Activation Strike'
);
comment on type app.advance_window_kind is 'What a Schedule Window section asks the time of (R9). Accepted Load In and Load Out windows can be booked as dock slots.';

create type app.sponsor_asset_source as enum ('Org Supplied', 'Sponsor Supplied');
comment on type app.sponsor_asset_source is 'Who supplies a sponsor asset (R9): the org, for the sponsor to approve in Gateway, or the sponsor, for the org to approve in Atlas.';

-- 2. Section kinds ------------------------------------------------------------------------------------------------------

alter table app.advance_sections
  add column section_kind app.advance_section_kind not null default 'Text',
  add column window_kind app.advance_window_kind,
  add column max_lines smallint,
  add column per_person boolean not null default false,
  add constraint advance_sections_kind_fields check (
    coalesce(case
      when section_kind in ('Text', 'Crew Roster', 'Guest List') then
        window_kind is null and max_lines is null and not per_person
      when section_kind = 'File' then
        window_kind is null and max_lines between 1 and 10 and not per_person
      when section_kind = 'Schedule Window' then
        window_kind is not null and max_lines between 1 and 5 and not per_person
      when section_kind in ('Item Request', 'Credential Request') then
        window_kind is null and max_lines between 1 and 50
    end, false));

comment on column app.advance_sections.section_kind is 'What the section asks for: Text, File, Schedule Window, Item Request, Crew Roster, Guest List or Credential Request (R9). Fixed once the packet is sent.';
comment on column app.advance_sections.window_kind is 'For a Schedule Window section, what the window is: Load In, Load Out, Arrival, Soundcheck, Activation Setup or Activation Strike; NULL for every other kind.';
comment on column app.advance_sections.max_lines is 'Most lines one answer may hold: files (1 to 10), windows (1 to 5), or item and credential lines (1 to 50); NULL for Text, Crew Roster and Guest List.';
comment on column app.advance_sections.per_person is 'For an Item Request or Credential Request, true when every line names one person on the engagement''s roster; false otherwise.';

-- 3. Choices -----------------------------------------------------------------------------------------------------------

create table app.advance_section_choices (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  advance_section_id uuid not null references app.advance_sections (id),
  asset_class_id uuid references app.asset_classes (id),
  credential_category_id uuid references app.credential_categories (id),
  deleted_at timestamptz,
  constraint advance_section_choices_one_target check (num_nonnulls(asset_class_id, credential_category_id) = 1)
);
create index advance_section_choices_section_idx on app.advance_section_choices (advance_section_id);
create index advance_section_choices_asset_class_id_idx on app.advance_section_choices (asset_class_id);
create index advance_section_choices_credential_category_id_idx on app.advance_section_choices (credential_category_id);
create unique index advance_section_choices_class_key on app.advance_section_choices (advance_section_id, asset_class_id)
  where asset_class_id is not null and deleted_at is null;
create unique index advance_section_choices_category_key on app.advance_section_choices (advance_section_id, credential_category_id)
  where credential_category_id is not null and deleted_at is null;

-- app.advance_sections carries no project_id, so the policies reach the project through the packet.
call private.install_domain_table('app.advance_section_choices', 'app.advance_sections', 'advance_section_id',
  array['app.asset_classes', 'asset_class_id', 'app.credential_categories', 'credential_category_id']);
call private.install_policies('app.advance_section_choices',
  $$advance_section_id in (select s.id from app.advance_sections s join app.advance_packets p on p.id = s.advance_packet_id
    where p.project_id in (select private.project_ids_with('advancing.packet.read')))$$,
  $$advance_section_id in (select s.id from app.advance_sections s join app.advance_packets p on p.id = s.advance_packet_id
    where p.project_id in (select private.project_ids_with('advancing.packet.write')))$$);
call private.describe('app.advance_section_choices', 'What an Item Request or Credential Request section offers (R9): an asset class of the org that answers for an offering, or a credential category of the packet''s project. One target per row; fixed once the packet is sent.', array[
  'advance_section_id', 'Section the choice belongs to.',
  'asset_class_id', 'Asset class an Item Request offers, such as the org''s radios or carts; its offering is checked on each answer line.',
  'credential_category_id', 'Credential category a Credential Request offers, of the packet''s project.'
]);
call private.install_audit_trail('app.advance_section_choices');
call private.install_default_retention('app.advance_section_choices');

create or replace function private.guard_advance_section_choice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind app.advance_section_kind;
  v_project uuid;
  v_sent timestamptz;
begin
  select s.section_kind, p.project_id, p.sent_at into v_kind, v_project, v_sent
  from app.advance_sections s join app.advance_packets p on p.id = s.advance_packet_id
  where s.id = new.advance_section_id;
  if v_sent is not null then
    perform private.refuse('advance_packet_sections_fixed', 'The sections of a sent packet are fixed; wording may still be corrected.');
  end if;
  if tg_op = 'UPDATE' and (new.advance_section_id <> old.advance_section_id
      or new.asset_class_id is distinct from old.asset_class_id
      or new.credential_category_id is distinct from old.credential_category_id) then
    perform private.refuse('advance_section_choice_fixed', 'A choice keeps its section and target; remove it and add another.');
  end if;
  if new.asset_class_id is not null then
    if v_kind <> 'Item Request' then
      perform private.refuse('advance_section_choice_kind', 'Asset classes are offered by an Item Request section.');
    end if;
    if not exists (select 1 from app.asset_classes c
                   where c.id = new.asset_class_id and c.org_id = new.org_id and c.offering is not null and c.deleted_at is null) then
      perform private.refuse('advance_section_choice_kind', 'Only a class that answers for an offering, such as radios or carts, is offered.');
    end if;
  else
    if v_kind <> 'Credential Request' then
      perform private.refuse('advance_section_choice_kind', 'Credential categories are offered by a Credential Request section.');
    end if;
    if not exists (select 1 from app.credential_categories k
                   where k.id = new.credential_category_id and k.project_id = v_project and k.deleted_at is null) then
      perform private.refuse('advance_section_choice_project', 'A credential category comes from the packet''s project.');
    end if;
  end if;
  return new;
end;
$$;
comment on function private.guard_advance_section_choice() is 'Advance section choices (R9): asset classes that answer for an offering go only on Item Request sections, credential categories of the packet''s project only on Credential Request sections, a choice keeps its section and target, and nothing changes once the packet is sent (advance_packet_sections_fixed).';
revoke all on function private.guard_advance_section_choice() from public, anon, authenticated;
create trigger t40_guard_advance_section_choice before insert or update on app.advance_section_choices
  for each row execute function private.guard_advance_section_choice();

-- 4. Sections are fixed after send, from 0430 -------------------------------------------------------------------------

create or replace function private.guard_advance_section()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from app.advance_packets p where p.id = new.advance_packet_id and p.sent_at is not null)
     and (tg_op = 'INSERT' or new.position is distinct from old.position or new.deleted_at is distinct from old.deleted_at
          or new.advance_packet_id is distinct from old.advance_packet_id
          or new.section_kind is distinct from old.section_kind or new.window_kind is distinct from old.window_kind
          or new.max_lines is distinct from old.max_lines or new.per_person is distinct from old.per_person) then
    perform private.refuse('advance_packet_sections_fixed', 'The sections of a sent packet are fixed; wording may still be corrected.');
  end if;
  if tg_op = 'UPDATE' and new.section_kind is distinct from old.section_kind
     and exists (select 1 from app.advance_section_choices c where c.advance_section_id = new.id and c.deleted_at is null) then
    perform private.refuse('advance_section_kind_choices', 'Remove the section''s choices before changing its kind.');
  end if;
  return new;
end;
$$;
comment on function private.guard_advance_section() is 'Once a packet is sent, sections are not added, removed or reordered, and their kind and configuration (window kind, most lines, per person) are fixed; titles and prompts may be corrected. A section with live choices keeps its kind (advance_section_kind_choices) (R9).';
revoke all on function private.guard_advance_section() from public, anon, authenticated;

-- 5. Sending needs every requested item offered, from 0430 -------------------------------------------------------------

create or replace function app.send_advance_packet(p_packet_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_packet app.advance_packets;
  v_now timestamptz := now();
begin
  select * into v_packet from app.advance_packets p where p.id = p_packet_id and p.deleted_at is null;
  if v_packet.id is null or not private.can_on_project(v_packet.project_id, 'advancing.packet.read') then
    raise exception using errcode = '42501', message = 'advance packet not found';
  end if;
  if not private.can_on_project(v_packet.project_id, 'advancing.packet.send') then
    perform private.refuse('advance_send_authority', 'Sending a packet needs advancing.packet.send on its project.');
  end if;
  if v_packet.sent_at is not null then
    perform private.refuse('advance_packet_sent', 'This packet was already sent.');
  end if;
  if not exists (select 1 from app.advance_sections s where s.advance_packet_id = p_packet_id and s.deleted_at is null) then
    perform private.refuse('advance_packet_no_sections', 'Add a section before sending.');
  end if;
  if not exists (select 1 from app.advance_recipients r where r.advance_packet_id = p_packet_id and r.deleted_at is null) then
    perform private.refuse('advance_packet_no_recipients', 'Add a recipient before sending.');
  end if;
  if exists (
      select 1 from app.advance_sections s
      where s.advance_packet_id = p_packet_id and s.deleted_at is null and s.section_kind in ('Item Request', 'Credential Request')
        and not exists (select 1 from app.advance_section_choices c where c.advance_section_id = s.id and c.deleted_at is null)) then
    perform private.refuse('advance_section_choices_missing', 'Give every Item Request and Credential Request section at least one choice before sending.');
  end if;
  perform private.begin_trusted_operation('send_advance_packet');
  update app.advance_packets p set sent_at = v_now where p.id = p_packet_id;
  perform private.end_trusted_operation('send_advance_packet');
  return v_now;
end;
$$;
comment on function app.send_advance_packet(uuid) is 'Sends a draft advance packet (advancing.packet.send on its project). Refuses a packet already sent, one without sections or recipients, and one with an Item Request or Credential Request section that offers nothing (advance_section_choices_missing, R9). Returns the send time.';
revoke all on function app.send_advance_packet(uuid) from public, anon;
grant execute on function app.send_advance_packet(uuid) to authenticated, service_role;

-- 6. The engagement a recipient answers under --------------------------------------------------------------------------

alter table app.advance_recipients add column engagement_id uuid references app.engagements (id);
create index advance_recipients_engagement_id_idx on app.advance_recipients (engagement_id);
comment on column app.advance_recipients.engagement_id is 'Engagement the recipient answers under (R9): live, on the packet''s project, and of the same party (its person or counterparty). Item Request, Credential Request and Guest List sections need it. NULL for token recipients and venues without an engagement. Fixed once the packet is sent.';

-- Backfilled before the guard exists, sent packets included: each recipient gets the one live engagement that matches.
create or replace function private.backfill_advance_recipient_engagements()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.begin_trusted_operation('backfill_advance_recipient_engagements');
  update app.advance_recipients r set engagement_id = m.engagement_id
  from (
    select r2.id, min(e.id::text)::uuid as engagement_id
    from app.advance_recipients r2
    join app.advance_packets p on p.id = r2.advance_packet_id
    join app.engagements e on e.project_id = p.project_id and e.deleted_at is null
      and e.engagement_state not in ('Complete', 'Canceled')
      and (e.person_id = r2.person_id or e.counterparty_id = r2.counterparty_id)
    where r2.deleted_at is null and r2.engagement_id is null
    group by r2.id
    having count(*) = 1
  ) m
  where m.id = r.id;
  get diagnostics v_count = row_count;
  perform private.end_trusted_operation('backfill_advance_recipient_engagements');
  return v_count;
end;
$$;
comment on function private.backfill_advance_recipient_engagements() is 'R9 backfill: links each live advance recipient without an engagement to the one live engagement (not Complete or Canceled) of the same party on the packet''s project, when exactly one matches; ambiguous and unmatched recipients stay unlinked. Returns the number linked. 2710 runs it once before the recipient engagement guard exists.';
revoke all on function private.backfill_advance_recipient_engagements() from public, anon, authenticated;
select private.backfill_advance_recipient_engagements();

create or replace function private.guard_advance_recipient_engagement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sent timestamptz;
  v_project uuid;
begin
  select p.sent_at, p.project_id into v_sent, v_project from app.advance_packets p where p.id = new.advance_packet_id;
  if tg_op = 'UPDATE' and new.engagement_id is distinct from old.engagement_id and v_sent is not null
     and not (old.engagement_id is null and private.in_trusted_operation('backfill_advance_recipient_engagements')) then
    perform private.refuse('advance_recipient_engagement', 'A recipient keeps its engagement once the packet is sent.');
  end if;
  if new.engagement_id is not null and (tg_op = 'INSERT' or new.engagement_id is distinct from old.engagement_id
      or new.person_id is distinct from old.person_id or new.counterparty_id is distinct from old.counterparty_id)
     and not exists (
       select 1 from app.engagements e
       where e.id = new.engagement_id and e.deleted_at is null and e.engagement_state not in ('Complete', 'Canceled')
         and e.project_id = v_project
         and (e.person_id = new.person_id or e.counterparty_id = new.counterparty_id)) then
    perform private.refuse('advance_recipient_engagement', 'The engagement is a live engagement of the same party on the packet''s project.');
  end if;
  return new;
end;
$$;
comment on function private.guard_advance_recipient_engagement() is 'Advance recipients (R9): the engagement is live (not deleted, Complete or Canceled), on the packet''s project and of the same party, its person or its counterparty, so the 0351 party binding and the engagement agree; it is fixed once the packet is sent (advance_recipient_engagement), except that the backfill links a sent recipient that had none.';
revoke all on function private.guard_advance_recipient_engagement() from public, anon, authenticated;
create trigger t41_guard_advance_recipient_engagement before insert or update on app.advance_recipients
  for each row execute function private.guard_advance_recipient_engagement();

-- 7. Who supplies a sponsor asset ---------------------------------------------------------------------------------------

alter table app.sponsor_assets add column asset_source app.sponsor_asset_source not null default 'Org Supplied';
comment on column app.sponsor_assets.asset_source is 'Who supplies the asset (R9): Org Supplied (the org uploads, the sponsor approves in Gateway) or Sponsor Supplied (the sponsor uploads through app.supply_sponsor_asset, the org approves in Atlas). Fixed at insert.';

create or replace function private.guard_sponsor_asset_source()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.asset_source = 'Sponsor Supplied' and not private.in_trusted_operation('supply_sponsor_asset') then
      perform private.refuse('sponsor_asset_source', 'A sponsor supplies its own asset through app.supply_sponsor_asset.');
    end if;
  elsif new.asset_source <> old.asset_source then
    perform private.refuse('sponsor_asset_source', 'An asset keeps who supplies it.');
  end if;
  return new;
end;
$$;
comment on function private.guard_sponsor_asset_source() is 'Sponsor assets (R9): a Sponsor Supplied asset is inserted only by app.supply_sponsor_asset, and no asset changes who supplies it (sponsor_asset_source).';
revoke all on function private.guard_sponsor_asset_source() from public, anon, authenticated;
create trigger t41_guard_sponsor_asset_source before insert or update on app.sponsor_assets
  for each row execute function private.guard_sponsor_asset_source();
