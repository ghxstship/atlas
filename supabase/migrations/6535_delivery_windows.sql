-- 6535_delivery_windows.sql
-- B11 Delivery windows (RRR-235, G-115, ADR 0150). A booking is a dock slot, so check-in, P9 approvals, the Gateway tab,
-- Up Next, exports and sync keep one source; the vehicle limit lives on a new parent, app.delivery_windows. This narrows
-- 0351's "Slots at one dock never overlap": bookings of one window share its time, and nothing else at the dock touches a
-- live window or its bookings.
--
--   * app.delivery_windows: a gate open for a time for up to vehicle_limit vehicles. Under the 0351 advisory lock
--     dock_slots:<zone>, it overlaps no other live window or direct slot at the zone; time and zone stay fixed while it
--     has live bookings, and neither its limit nor its deletion leaves a booking without a place.
--   * app.dock_slots.delivery_window_id: written only inside the booking's trusted operation and fixed
--     (delivery_booking_direct), so a direct PATCH can neither attach nor detach a booking and dodge the limit.
--   * app.dock_slots.reference_code: issued only for a booking, six characters from an alphabet with no look-alikes,
--     built from pg_catalog.gen_random_uuid() so ADR 0001's extension list stays. It is a lookup label, not a credential.
--   * app.dock_slots.vehicle_identifier: the plate the vendor gave; external readers of other vendors never see it.
--   * private.guard_dock_slot (from 0351, its only definition) learns bookings: within their window on its zone, and
--     within its limit, also when one is restored from Trash. Lock order: the window row, then the advisory lock, the
--     order a window update already holds.
--   * app.gate_queue.dock_slot_id: at most one live gate row per slot, of the same project.
--   * private.project_docks_full_at (from 2683, its only definition): an open window with places left no longer counts
--     as taken, and a zone with only windows counts, so the G-99 warnings stay true.

-- 1. Windows ---------------------------------------------------------------------------------------------------------------------

create table app.delivery_windows (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  zone_id uuid not null references app.zones (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  vehicle_limit integer not null,
  is_open boolean not null default true,
  deleted_at timestamptz,
  constraint delivery_windows_order check (ends_at > starts_at),
  constraint delivery_windows_limit_range check (vehicle_limit between 1 and 500)
);
create index delivery_windows_project_id_idx on app.delivery_windows (project_id, starts_at);
create index delivery_windows_zone_id_idx on app.delivery_windows (zone_id, starts_at);

call private.install_project_table('app.delivery_windows', 'logistics.shipment.read', 'logistics.dock_slot.write', array['app.zones', 'zone_id']);
call private.describe('app.delivery_windows', 'A gate open for a time for up to a number of vehicles (B11, G-115, ADR 0150). Vendors book a place in it, and each booking is a dock slot. It overlaps no other live window or direct slot at its zone.', array[
  'project_id', 'Project.',
  'zone_id', 'Gate: a live zone of the org.',
  'starts_at', 'When the window opens. Fixed while it has live bookings.',
  'ends_at', 'When the window closes. Fixed while it has live bookings.',
  'vehicle_limit', 'How many vehicles the window takes, 1 to 500; never below its live bookings.',
  'is_open', 'False stops new bookings; bookings already made stay.'
]);
call private.install_default_retention('app.delivery_windows');
call private.install_audit_trail('app.delivery_windows');
insert into private.field_history_subjects (table_name) values ('app.delivery_windows') on conflict do nothing;
insert into private.comment_subjects (table_name) values ('app.delivery_windows') on conflict do nothing;
insert into private.trash_excluded_tables (table_name, rationale) values
  ('delivery_windows', 'A slot of a generated schedule with no title of its own; the coordinator generates it again, and a restored window could overlap what was booked since.')
on conflict (table_name) do nothing;

-- 2. Bookings ----------------------------------------------------------------------------------------------------------------------

alter table app.dock_slots add column delivery_window_id uuid references app.delivery_windows (id);
alter table app.dock_slots add column reference_code text;
alter table app.dock_slots add column vehicle_identifier text;
create index dock_slots_delivery_window_idx on app.dock_slots (delivery_window_id);
create unique index dock_slots_reference_code_key on app.dock_slots (project_id, reference_code) where reference_code is not null;
alter table app.dock_slots add constraint dock_slots_reference_code_format check (reference_code is null or reference_code ~ '^[23456789A-HJ-NP-Z]{6}$');
alter table app.dock_slots add constraint dock_slots_reference_code_booking check ((reference_code is null) = (delivery_window_id is null));
alter table app.dock_slots add constraint dock_slots_vehicle_identifier_length check (vehicle_identifier is null or char_length(btrim(vehicle_identifier)) between 1 and 40);
comment on column app.dock_slots.delivery_window_id is 'Delivery window this slot holds a place in (B11, ADR 0150); NULL for a slot booked directly. Written only by app.book_delivery_window and never changes.';
comment on column app.dock_slots.reference_code is 'Six-character label a vendor quotes at the gate, issued only for a booking, fixed once set, unique per project. A lookup label, not a credential.';
comment on column app.dock_slots.vehicle_identifier is 'Plate or trailer number of the vehicle expected; NULL until the vendor knows it.';
call private.add_cross_org_references('app.dock_slots', array['app.delivery_windows', 'delivery_window_id']);
insert into private.field_history_subjects (table_name) values ('app.dock_slots') on conflict do nothing;

create or replace function private.issue_booking_reference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_bytes bytea;
  v_code text;
begin
  if tg_op = 'UPDATE' then
    if new.reference_code is distinct from old.reference_code then
      perform private.refuse('delivery_booking_reference', 'A booking keeps its reference code.');
    end if;
    return new;
  end if;
  if new.delivery_window_id is null then
    if new.reference_code is not null then
      perform private.refuse('delivery_booking_reference', 'A booking keeps its reference code.');
    end if;
    return new;
  end if;
  loop
    v_bytes := pg_catalog.uuid_send(pg_catalog.gen_random_uuid());
    -- Bytes 0 to 5 of a version 4 UUID are all random; 32 letters take five bits of each.
    v_code := '';
    for i in 0..5 loop
      v_code := v_code || substr(v_alphabet, (pg_catalog.get_byte(v_bytes, i) & 31) + 1, 1);
    end loop;
    exit when not exists (select 1 from app.dock_slots d where d.project_id = new.project_id and d.reference_code = v_code);
  end loop;
  new.reference_code := v_code;
  return new;
end;
$$;
comment on function private.issue_booking_reference() is 'Before insert or update: issues a booking''s reference code from pg_catalog.gen_random_uuid() bytes, retrying a collision in the project, and keeps it fixed (delivery_booking_reference). A direct slot has none.';
revoke all on function private.issue_booking_reference() from public, anon, authenticated;
create trigger t35_issue_booking_reference before insert or update on app.dock_slots
  for each row execute function private.issue_booking_reference();

-- From 0351, its only definition.
create or replace function private.guard_dock_slot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window app.delivery_windows;
  v_booked integer;
begin
  if (tg_op = 'INSERT' and new.delivery_window_id is not null and not private.in_trusted_operation('book_delivery_window'))
     or (tg_op = 'UPDATE' and new.delivery_window_id is distinct from old.delivery_window_id) then
    perform private.refuse('delivery_booking_direct', 'A delivery is booked with Book a delivery and stays in its window.');
  end if;
  if new.ends_at <= new.starts_at then
    return new;
  end if;
  -- The window row first, then the advisory lock: the order a window update holds them in.
  if new.delivery_window_id is not null then
    select w.* into v_window from app.delivery_windows w where w.id = new.delivery_window_id for update;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dock_slots:' || new.zone_id::text, 0));
  if new.deleted_at is not null then
    return new;
  end if;
  if new.delivery_window_id is not null then
    if v_window.deleted_at is not null then
      perform private.refuse('delivery_window_closed', 'This window is no longer open for booking.');
    end if;
    if new.zone_id <> v_window.zone_id or new.starts_at < v_window.starts_at or new.ends_at > v_window.ends_at then
      perform private.refuse('delivery_booking_outside_window', 'A booking stays inside its window, at its gate.');
    end if;
    if tg_op = 'INSERT' or old.deleted_at is not null then
      select count(*) into v_booked from app.dock_slots d
      where d.delivery_window_id = new.delivery_window_id and d.deleted_at is null and d.id <> new.id;
      if v_booked >= v_window.vehicle_limit then
        perform private.refuse('delivery_window_full', 'This window is full. Choose another window.');
      end if;
    end if;
    -- Bookings of one window share its time; anything else at the gate still may not touch it.
    if exists (
      select 1 from app.dock_slots d where d.zone_id = new.zone_id and d.id <> new.id and d.deleted_at is null
        and d.delivery_window_id is distinct from new.delivery_window_id
        and tstzrange(d.starts_at, d.ends_at) && tstzrange(new.starts_at, new.ends_at)) then
      perform private.refuse('dock_slot_overlap', 'Slots at one dock never overlap.');
    end if;
    return new;
  end if;
  if exists (
    select 1 from app.dock_slots d where d.zone_id = new.zone_id and d.id <> new.id and d.deleted_at is null
      and tstzrange(d.starts_at, d.ends_at) && tstzrange(new.starts_at, new.ends_at))
     or exists (
    select 1 from app.delivery_windows w where w.zone_id = new.zone_id and w.deleted_at is null
      and tstzrange(w.starts_at, w.ends_at) && tstzrange(new.starts_at, new.ends_at)) then
    perform private.refuse('dock_slot_overlap', 'Slots at one dock never overlap.');
  end if;
  return new;
end;
$$;
comment on function private.guard_dock_slot() is 'Dock slots at one zone never overlap, except bookings of one delivery window (ADR 0150). A direct slot also keeps clear of live windows (dock_slot_overlap). A booking is made only inside app.book_delivery_window and keeps its window (delivery_booking_direct); it stays inside the window on its zone, also through a bulk move (delivery_booking_outside_window), and within its limit, also when restored from Trash (delivery_window_full).';
revoke all on function private.guard_dock_slot() from public, anon, authenticated;

create or replace function private.guard_delivery_window()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booked integer := 0;
begin
  if not exists (select 1 from app.zones z where z.id = new.zone_id and z.org_id = new.org_id and z.deleted_at is null) then
    perform private.refuse('delivery_window_zone', 'Choose a live gate of the organization.');
  end if;
  if new.ends_at <= new.starts_at then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dock_slots:' || new.zone_id::text, 0));
  if tg_op = 'UPDATE' then
    select count(*) into v_booked from app.dock_slots d where d.delivery_window_id = new.id and d.deleted_at is null;
    if v_booked > 0 and (new.zone_id <> old.zone_id or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at
                         or (new.deleted_at is not null and old.deleted_at is null)) then
      perform private.refuse('delivery_window_booked', 'This window has bookings. Cancel them first.');
    end if;
    if new.vehicle_limit < v_booked then
      perform private.refuse('delivery_window_limit', 'This window already has more bookings than that.');
    end if;
    if new.project_id <> old.project_id then
      perform private.refuse('delivery_window_booked', 'This window has bookings. Cancel them first.');
    end if;
  end if;
  if new.deleted_at is null and (
    exists (select 1 from app.delivery_windows w where w.zone_id = new.zone_id and w.id <> new.id and w.deleted_at is null
              and tstzrange(w.starts_at, w.ends_at) && tstzrange(new.starts_at, new.ends_at))
    or exists (select 1 from app.dock_slots d where d.zone_id = new.zone_id and d.delivery_window_id is distinct from new.id and d.deleted_at is null
              and tstzrange(d.starts_at, d.ends_at) && tstzrange(new.starts_at, new.ends_at))) then
    perform private.refuse('delivery_window_overlap', 'A window keeps clear of other windows and slots at its gate.');
  end if;
  return new;
end;
$$;
comment on function private.guard_delivery_window() is 'Delivery windows: a live gate of the org (delivery_window_zone), clear of other live windows and slots at the zone under the 0351 advisory lock (delivery_window_overlap), time, zone and life fixed while it has live bookings (delivery_window_booked), and a limit never below them (delivery_window_limit).';
revoke all on function private.guard_delivery_window() from public, anon, authenticated;
create trigger t40_guard_delivery_window before insert or update on app.delivery_windows
  for each row execute function private.guard_delivery_window();

-- 3. The gate queue names the slot ----------------------------------------------------------------------------------------------

alter table app.gate_queue add column dock_slot_id uuid references app.dock_slots (id);
create unique index gate_queue_dock_slot_key on app.gate_queue (dock_slot_id) where dock_slot_id is not null and deleted_at is null;
comment on column app.gate_queue.dock_slot_id is 'Booking the vehicle arrived for (B11, G-115), at most one live gate row per slot; NULL for a vehicle with no booking.';
call private.add_cross_org_references('app.gate_queue', array['app.dock_slots', 'dock_slot_id']);
create trigger t39_gate_queue_dock_slot_project before insert or update on app.gate_queue
  for each row execute function private.assert_same_project('app.dock_slots', 'dock_slot_id');

-- 4. G-99 warnings stay true ------------------------------------------------------------------------------------------------------

-- From 2683, its only definition.
create or replace function private.project_docks_full_at(p_project_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with zones as (
    select d.zone_id from app.dock_slots d where d.project_id = p_project_id and d.deleted_at is null
    union
    select w.zone_id from app.delivery_windows w where w.project_id = p_project_id and w.deleted_at is null
  )
  select p_at is not null
    and private.can_on_project(p_project_id, 'procurement.po.read')
    and exists (select 1 from zones)
    and not exists (
      select 1 from zones z
      where not exists (
        select 1 from app.dock_slots s
        where s.zone_id = z.zone_id and s.delivery_window_id is null and s.deleted_at is null and s.starts_at <= p_at and s.ends_at > p_at)
      and not exists (
        select 1 from app.delivery_windows w
        where w.zone_id = z.zone_id and w.deleted_at is null and w.starts_at <= p_at and w.ends_at > p_at
          and (not w.is_open or (select count(*) from app.dock_slots b where b.delivery_window_id = w.id and b.deleted_at is null) >= w.vehicle_limit)));
$$;
comment on function private.project_docks_full_at(uuid, timestamptz) is 'True when the project books dock slots or windows and every zone it books is taken at the instant: by a live direct slot, or by a live window that is closed or has no place left (R7a, G-99; B11, ADR 0150), so a delivery or collection then finds no free dock. False unless the caller reads purchase orders on the project (procurement.po.read).';
revoke all on function private.project_docks_full_at(uuid, timestamptz) from public, anon;
grant execute on function private.project_docks_full_at(uuid, timestamptz) to authenticated, service_role;
