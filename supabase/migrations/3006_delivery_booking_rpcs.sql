-- 3006_delivery_booking_rpcs.sql
-- B11 Delivery windows, booking and the gate (RRR-235, G-115, ADR 0150).
--
--   * app.create_delivery_windows: a schedule of windows at one gate on the project's calendar, DST safe: a local time
--     the clocks skip gets no window.
--   * app.book_delivery_window: the vendor's own booking, or a coordinator's for them, keyed by the event id. A trusted
--     operation performs the insert, so created_by stays the person and t91_open_delivery_approval (2860) opens the
--     rule's approval with the vendor as requester. A Rejected delivery approval frees no place, because ADR 0138 does
--     not gate deliveries: the coordinator cancels. A restored booking opens no approval, because that trigger is
--     insert-only (ADR 0150).
--   * app.cancel_delivery_booking and app.set_delivery_booking_vehicle: the vendor or the coordinator, until check-in.
--   * app.record_booking_arrival: replayable from Compass (private.sync_rpcs), so security definer as 0935 requires.
--   * api_external.dock_slots gains four columns at its end, and api_external.delivery_windows lists open, future
--     windows with places left and no other vendor.

create or replace function app.create_delivery_windows(
  p_project_id uuid,
  p_zone_id uuid,
  p_first_day date,
  p_last_day date,
  p_from_time time,
  p_to_time time,
  p_slot_minutes integer,
  p_vehicle_limit integer
)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_day date;
  v_at time;
  v_step interval;
  v_starts timestamptz;
  v_ends timestamptz;
  v_id uuid;
  v_ids uuid[] := '{}';
begin
  perform private.require_person();
  select p.time_zone into v_zone from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_zone is null or not private.can_on_project(p_project_id, 'logistics.dock_slot.write') then
    raise exception using errcode = '42501', message = 'logistics.dock_slot.write is required on the project';
  end if;
  if p_first_day is null or p_last_day is null or p_last_day < p_first_day or p_from_time is null or p_to_time is null
     or p_to_time <= p_from_time or coalesce(p_slot_minutes, 0) < 5 or p_slot_minutes > 1440
     or make_interval(mins => p_slot_minutes) > (p_to_time - p_from_time) then
    perform private.refuse('delivery_window_range', 'Choose days in order, and a slot length that fits from the start time to the end time.');
  end if;
  if (p_last_day - p_first_day + 1) * floor(extract(epoch from (p_to_time - p_from_time)) / (p_slot_minutes * 60)) > 500 then
    perform private.refuse('delivery_window_count', 'Add at most 500 windows at a time.');
  end if;
  v_step := make_interval(mins => p_slot_minutes);
  v_day := p_first_day;
  while v_day <= p_last_day loop
    v_at := p_from_time;
    while (v_day + v_at) + v_step <= v_day + p_to_time loop
      v_starts := (v_day + v_at) at time zone v_zone;
      v_ends := ((v_day + v_at) + v_step) at time zone v_zone;
      -- A local time the clocks skip reads back as another time: no window then.
      if (v_starts at time zone v_zone) = (v_day + v_at) and v_ends > v_starts then
        insert into app.delivery_windows (project_id, zone_id, starts_at, ends_at, vehicle_limit)
        values (p_project_id, p_zone_id, v_starts, v_ends, p_vehicle_limit)
        returning id into v_id;
        v_ids := v_ids || v_id;
      end if;
      exit when ((v_day + v_at) + v_step)::date <> v_day;
      v_at := v_at + v_step;
    end loop;
    v_day := v_day + 1;
  end loop;
  return v_ids;
end;
$$;
comment on function app.create_delivery_windows(uuid, uuid, date, date, time, time, integer, integer) is 'Adds delivery windows at a gate for each day, from a local start to a local end in slots of a length, on the project''s calendar (B11, G-115), and returns their ids. logistics.dock_slot.write on the project (42501 otherwise). Days out of order or a slot that does not fit refuse delivery_window_range; above 500 windows refuses delivery_window_count. A local time the clocks skip gets no window.';
revoke all on function app.create_delivery_windows(uuid, uuid, date, date, time, time, integer, integer) from public, anon;
grant execute on function app.create_delivery_windows(uuid, uuid, date, date, time, time, integer, integer) to authenticated, service_role;

create or replace function private.may_manage_booking(p_project_id uuid, p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_on_project(p_project_id, 'logistics.dock_slot.write')
    or (p_engagement_id is not null and exists (
      select 1 from app.engagements e
      where e.id = p_engagement_id and e.project_id = p_project_id and e.role_type = 'Vendor' and e.deleted_at is null
        and e.id in (select private.my_engagement_ids('operational'))));
$$;
comment on function private.may_manage_booking(uuid, uuid) is 'True when the signed-in person writes dock slots on the project, or reaches this Vendor engagement of the project in the operational area.';
revoke all on function private.may_manage_booking(uuid, uuid) from public, anon, authenticated;

create or replace function app.book_delivery_window(
  p_event_id uuid,
  p_window_id uuid,
  p_engagement_id uuid default null,
  p_vehicle_identifier text default null,
  p_shipment_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_window app.delivery_windows;
  v_existing app.dock_slots;
begin
  perform private.require_person();
  -- The window row first, then the advisory lock in the guard: the order a window update holds them in.
  select w.* into v_window from app.delivery_windows w where w.id = p_window_id for update;
  if v_window.id is null or not private.may_manage_booking(v_window.project_id, p_engagement_id) then
    raise exception using errcode = '42501', message = 'logistics.dock_slot.write or a Vendor engagement of the project is required';
  end if;
  select d.* into v_existing from app.dock_slots d where d.id = p_event_id;
  if v_existing.id is not null then
    if v_existing.delivery_window_id is distinct from p_window_id or v_existing.engagement_id is distinct from p_engagement_id then
      perform private.refuse('booking_event_reused', 'This booking was already used for another window or company.');
    end if;
    return v_existing.id;
  end if;
  if v_window.deleted_at is not null or not v_window.is_open or v_window.starts_at <= now() then
    perform private.refuse('delivery_window_closed', 'This window is no longer open for booking.');
  end if;
  if p_shipment_id is not null and not private.can_on_project(v_window.project_id, 'logistics.dock_slot.write')
     and not private.external_dock_slot_visible(v_window.project_id, p_shipment_id) then
    perform private.refuse('delivery_booking_shipment', 'Choose a shipment your company carries.');
  end if;
  perform private.begin_trusted_operation('book_delivery_window');
  insert into app.dock_slots (id, project_id, zone_id, starts_at, ends_at, engagement_id, shipment_id, delivery_window_id, vehicle_identifier)
  values (p_event_id, v_window.project_id, v_window.zone_id, v_window.starts_at, v_window.ends_at, p_engagement_id, p_shipment_id,
    p_window_id, nullif(btrim(coalesce(p_vehicle_identifier, '')), ''));
  perform private.end_trusted_operation('book_delivery_window');
  return p_event_id;
end;
$$;
comment on function app.book_delivery_window(uuid, uuid, uuid, text, uuid) is 'Books a place in a delivery window (B11, G-115): the event id is the slot id, so a replay creates nothing (booking_event_reused when it names another window or engagement). The caller holds logistics.dock_slot.write on the project, or p_engagement_id is a Vendor engagement of the project in private.my_engagement_ids(''operational'') (42501 otherwise). A closed, started or deleted window refuses delivery_window_closed, a shipment the vendor does not carry delivery_booking_shipment, and a full one delivery_window_full. A matching Delivery rule opens its approval with the booker as requester.';
revoke all on function app.book_delivery_window(uuid, uuid, uuid, text, uuid) from public, anon;
grant execute on function app.book_delivery_window(uuid, uuid, uuid, text, uuid) to authenticated, service_role;

create or replace function app.cancel_delivery_booking(p_dock_slot_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_slot app.dock_slots;
begin
  perform private.require_person();
  select d.* into v_slot from app.dock_slots d where d.id = p_dock_slot_id and d.deleted_at is null and d.delivery_window_id is not null for update;
  if v_slot.id is null or not private.may_manage_booking(v_slot.project_id, v_slot.engagement_id) then
    raise exception using errcode = '42501', message = 'logistics.dock_slot.write or the booking''s engagement is required';
  end if;
  if v_slot.checked_in_at is not null or v_slot.starts_at <= now() then
    perform private.refuse('delivery_booking_locked', 'This booking has started or checked in.');
  end if;
  update app.dock_slots set deleted_at = now() where id = v_slot.id;
end;
$$;
comment on function app.cancel_delivery_booking(uuid) is 'Cancels a booking and frees its place (B11, G-115): its engagement or a dock writer (42501 otherwise), before check-in and before the window starts (delivery_booking_locked). The soft delete cancels its approval through t91_cancel_delivery_approval (2860).';
revoke all on function app.cancel_delivery_booking(uuid) from public, anon;
grant execute on function app.cancel_delivery_booking(uuid) to authenticated, service_role;

create or replace function app.set_delivery_booking_vehicle(p_dock_slot_id uuid, p_vehicle_identifier text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_slot app.dock_slots;
begin
  perform private.require_person();
  select d.* into v_slot from app.dock_slots d where d.id = p_dock_slot_id and d.deleted_at is null and d.delivery_window_id is not null for update;
  if v_slot.id is null or not private.may_manage_booking(v_slot.project_id, v_slot.engagement_id) then
    raise exception using errcode = '42501', message = 'logistics.dock_slot.write or the booking''s engagement is required';
  end if;
  if v_slot.checked_in_at is not null then
    perform private.refuse('delivery_booking_locked', 'This booking has started or checked in.');
  end if;
  update app.dock_slots set vehicle_identifier = nullif(btrim(coalesce(p_vehicle_identifier, '')), '') where id = v_slot.id;
end;
$$;
comment on function app.set_delivery_booking_vehicle(uuid, text) is 'Changes the plate on a booking until it checks in (B11, G-115): its engagement or a dock writer (42501 otherwise); after check-in refuses delivery_booking_locked. An empty value clears it.';
revoke all on function app.set_delivery_booking_vehicle(uuid, text) from public, anon;
grant execute on function app.set_delivery_booking_vehicle(uuid, text) to authenticated, service_role;

create or replace function app.record_booking_arrival(p_dock_slot_id uuid, p_vehicle_identifier text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_slot app.dock_slots;
  v_vehicle text;
  v_id uuid;
begin
  select d.* into v_slot from app.dock_slots d where d.id = p_dock_slot_id for update;
  if v_slot.id is null or v_slot.project_id not in (select private.project_ids_with('logistics.yard.write')) then
    raise exception using errcode = '42501', message = 'logistics.yard.write is required on this project';
  end if;
  if v_slot.deleted_at is not null then
    perform private.refuse('dock_slot_canceled', 'A canceled dock slot cannot be checked in.');
  end if;
  if exists (select 1 from app.gate_queue q where q.dock_slot_id = v_slot.id and q.deleted_at is null) then
    perform private.refuse('booking_already_arrived', 'This booking has already arrived.');
  end if;
  v_vehicle := coalesce(nullif(btrim(coalesce(p_vehicle_identifier, '')), ''), v_slot.vehicle_identifier);
  if v_vehicle is null then
    perform private.refuse('gate_vehicle_required', 'Enter the plate or trailer number.');
  end if;
  insert into app.gate_queue (project_id, vehicle_identifier, shipment_id, dock_slot_id)
  values (v_slot.project_id, v_vehicle, v_slot.shipment_id, v_slot.id)
  returning id into v_id;
  return v_id;
end;
$$;
comment on function app.record_booking_arrival(uuid, text) is 'A vehicle arrived at the gate for its booking (B11, G-115): one gate row for the slot, under logistics.yard.write on the project (42501 otherwise). It uses the slot''s plate when none is given, else refuses gate_vehicle_required; a repeat refuses booking_already_arrived and a canceled slot dock_slot_canceled. Security definer because private.sync_call refuses any other (0935), and replayable from Compass.';
revoke all on function app.record_booking_arrival(uuid, text) from public, anon;
grant execute on function app.record_booking_arrival(uuid, text) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.record_booking_arrival', 'A gate marshal records a vehicle arriving for its delivery booking.')
on conflict (rpc) do nothing;

-- External views ----------------------------------------------------------------------------------------------------------------------

-- From 1000: four columns at the end, from the same rows.
create or replace view api_external.dock_slots as
select d.id, d.project_id, p.name as project_name, d.zone_id, z.code as zone_code, z.name as zone_name, d.shipment_id,
  s.direction, s.tracking_identifier, d.starts_at, d.ends_at, d.engagement_id,
  d.reference_code, d.vehicle_identifier, d.delivery_window_id, p.time_zone
from app.dock_slots d
join app.projects p on p.id = d.project_id
join app.zones z on z.id = d.zone_id
left join app.shipments s on s.id = d.shipment_id
where d.deleted_at is null
  and ((d.shipment_id is not null and private.external_dock_slot_visible(d.project_id, d.shipment_id))
    or d.engagement_id in (select private.my_engagement_ids('operational')));

comment on column api_external.dock_slots.reference_code is 'Six-character label to quote at the gate, for a booking; NULL for a slot booked directly.';
comment on column api_external.dock_slots.vehicle_identifier is 'Plate or trailer number expected on the booking; NULL until given.';
comment on column api_external.dock_slots.delivery_window_id is 'Delivery window the booking holds a place in; NULL for a slot booked directly.';
comment on column api_external.dock_slots.time_zone is 'Time zone of the project, for reading the slot''s times.';

create view api_external.delivery_windows as
select w.id, w.project_id, p.name as project_name, p.time_zone, w.zone_id, z.code as zone_code, z.name as zone_name, w.starts_at, w.ends_at,
  greatest(w.vehicle_limit - (select count(*) from app.dock_slots d where d.delivery_window_id = w.id and d.deleted_at is null), 0)::integer as places_left
from app.delivery_windows w
join app.projects p on p.id = w.project_id
join app.zones z on z.id = w.zone_id
where w.deleted_at is null and w.is_open and w.starts_at > now()
  and w.project_id in (select e.project_id from app.engagements e
    where e.role_type = 'Vendor' and e.deleted_at is null and e.id in (select private.my_engagement_ids('operational')));

comment on view api_external.delivery_windows is 'Open, future delivery windows of projects where the caller has an operational Vendor engagement (B11, G-115): the gate, the times, the project''s time zone and how many places are left. Never another vendor.';
comment on column api_external.delivery_windows.id is 'Delivery window.';
comment on column api_external.delivery_windows.project_id is 'Project.';
comment on column api_external.delivery_windows.project_name is 'Name of the project.';
comment on column api_external.delivery_windows.time_zone is 'Time zone of the project.';
comment on column api_external.delivery_windows.zone_id is 'Gate.';
comment on column api_external.delivery_windows.zone_code is 'Code of the gate.';
comment on column api_external.delivery_windows.zone_name is 'Name of the gate.';
comment on column api_external.delivery_windows.starts_at is 'When the window opens.';
comment on column api_external.delivery_windows.ends_at is 'When the window closes.';
comment on column api_external.delivery_windows.places_left is 'Vehicles it can still take; 0 when full.';
revoke all on api_external.delivery_windows from public, anon;
grant select on api_external.delivery_windows to authenticated, service_role;
