-- 0442_travel_and_field_rpcs.sql
-- A11 Hospitality and Logistics (RRR-23, range 0440 to 0449):
--   * travel segments: flights and ground transport for the people a project moves, optionally under a
--     Travel fulfillment of the same project, NULL price meaning unpriced. A28b projects them into the
--     crew and artist travel tabs of Gateway (Section 4.5.8);
--   * field RPCs for the Compass logistics screens (Section 4.5.7, More > Logistics), allowlisted for
--     offline replay through app.apply_sync_mutation. They run with the caller's rights, so the 0351
--     and 0440 policies and triggers decide each write exactly as for Atlas.

-- Travel segments --------------------------------------------------------------------------------------------

create type app.travel_mode as enum ('Flight', 'Ground');
comment on type app.travel_mode is 'How a traveler moves on a segment: Flight, or Ground transport such as a car service, shuttle or rail.';

create table app.travel_segments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  person_id uuid not null references app.people (id),
  fulfillment_id uuid references app.fulfillments (id),
  travel_mode app.travel_mode not null,
  operator_name text,
  service_identifier text,
  confirmation_identifier text,
  departs_from text not null,
  departs_at timestamptz not null,
  departs_time_zone text not null,
  arrives_at_place text not null,
  arrives_at timestamptz,
  arrives_time_zone text not null,
  price_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint travel_segments_window check (arrives_at is null or arrives_at >= departs_at),
  constraint travel_segments_price_currency check (price_minor is null or currency_code is not null),
  constraint travel_segments_price_nonnegative check (price_minor is null or price_minor >= 0),
  constraint travel_segments_places check (char_length(btrim(departs_from)) between 1 and 200 and char_length(btrim(arrives_at_place)) between 1 and 200),
  constraint travel_segments_operator_length check (operator_name is null or char_length(btrim(operator_name)) between 1 and 120),
  constraint travel_segments_service_length check (service_identifier is null or char_length(btrim(service_identifier)) between 1 and 40),
  constraint travel_segments_confirmation_length check (confirmation_identifier is null or char_length(btrim(confirmation_identifier)) between 1 and 40)
);
create index travel_segments_project_id_idx on app.travel_segments (project_id, departs_at);
create index travel_segments_person_id_idx on app.travel_segments (person_id, departs_at);
create index travel_segments_fulfillment_id_idx on app.travel_segments (fulfillment_id);
create index travel_segments_currency_code_idx on app.travel_segments (currency_code);
call private.install_project_table('app.travel_segments', 'hospitality.fulfillment.read', 'hospitality.fulfillment.write', array['app.fulfillments', 'fulfillment_id']);
call private.describe('app.travel_segments', 'Flights and ground transport for the people a project moves. A NULL price is unpriced.', array[
  'project_id', 'Project.', 'person_id', 'Traveler.', 'fulfillment_id', 'Travel fulfillment of the same project the segment belongs to, when one does.',
  'travel_mode', 'Flight or Ground.', 'operator_name', 'Airline, car service or other operator.',
  'service_identifier', 'Flight or service number, issued by the operator.', 'confirmation_identifier', 'Booking confirmation code, issued by the operator.',
  'departs_from', 'Departure airport, station or pickup address.', 'departs_at', 'Departure instant.', 'departs_time_zone', 'IANA zone the departure time was entered in.',
  'arrives_at_place', 'Arrival airport, station or drop-off address.', 'arrives_at', 'Arrival instant, when known.', 'arrives_time_zone', 'IANA zone the arrival time was entered in.',
  'price_minor', 'Fare in minor units; NULL is unpriced.', 'currency_code', 'ISO 4217 currency of the fare.'
]);

create or replace function private.guard_travel_segment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_time_zone(new.departs_time_zone);
  perform private.assert_time_zone(new.arrives_time_zone);
  if new.fulfillment_id is not null and (select f.fulfillment_kind from app.fulfillments f where f.id = new.fulfillment_id) <> 'Travel' then
    perform private.refuse('travel_fulfillment_kind', 'A travel segment belongs to a Travel fulfillment.');
  end if;
  return new;
end;
$$;

comment on function private.guard_travel_segment() is 'Travel segment zones are IANA zones, and a segment''s fulfillment is a Travel fulfillment.';
revoke all on function private.guard_travel_segment() from public, anon, authenticated;
create trigger t40_guard_travel_segment before insert or update on app.travel_segments
  for each row execute function private.guard_travel_segment();
create trigger t39_travel_segment_project before insert or update on app.travel_segments
  for each row execute function private.assert_same_project('app.fulfillments', 'fulfillment_id');

insert into private.domain_event_types (code, subject, description) values
  ('travel_segment.created', 'travel_segments', 'A flight or ground transport segment was booked for a traveler.'),
  ('travel_segment.canceled', 'travel_segments', 'A travel segment was canceled.')
on conflict (code) do nothing;

create trigger t90_emit_travel_created after insert on app.travel_segments
  for each row execute function private.emit_row_event('travel_segment.created', 'project_id', 'person_id', 'travel_mode', 'departs_at');
create trigger t90_emit_travel_canceled after update of deleted_at on app.travel_segments
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_subject_event('travel_segment.canceled', 'travel_segments', 'id', 'person_id', 'travel_mode', 'departs_at');

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table app.travel_segments;
  end if;
  if to_regprocedure('private.install_default_retention(regclass, interval)') is not null then
    call private.install_default_retention('app.travel_segments');
  end if;
end;
$$;

-- Field RPCs -------------------------------------------------------------------------------------------------

create or replace function app.check_in_dock_slot(p_dock_slot_id uuid)
returns timestamptz
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  update app.dock_slots set checked_in_at = now()
  where id = p_dock_slot_id and checked_in_at is null and deleted_at is null
  returning checked_in_at into v_at;
  if v_at is null then
    raise exception using errcode = 'XR001', hint = 'dock_slot_not_open',
      message = 'dock_slot_not_open: This dock slot is already checked in, canceled or not yours to change.';
  end if;
  return v_at;
end;
$$;

comment on function app.check_in_dock_slot(uuid) is 'Checks a shipment in at its dock slot with the caller''s rights; the 0440 trigger needs logistics.yard.write or logistics.dock_slot.write and stamps the time and person.';

create or replace function app.record_gate_arrival(p_project_id uuid, p_vehicle_identifier text, p_shipment_id uuid default null)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  insert into app.gate_queue (project_id, vehicle_identifier, shipment_id)
  values (p_project_id, btrim(p_vehicle_identifier), p_shipment_id)
  returning id;
$$;

comment on function app.record_gate_arrival(uuid, text, uuid) is 'Records a vehicle arriving at the site gate with the caller''s rights (logistics.yard.write on the project).';

create or replace function app.release_vehicle(p_gate_queue_id uuid)
returns timestamptz
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  update app.gate_queue set released_at = now()
  where id = p_gate_queue_id and released_at is null and deleted_at is null
  returning released_at into v_at;
  if v_at is null then
    raise exception using errcode = 'XR001', hint = 'vehicle_not_waiting',
      message = 'vehicle_not_waiting: This vehicle is already released or not yours to release.';
  end if;
  return v_at;
end;
$$;

comment on function app.release_vehicle(uuid) is 'Releases a waiting vehicle into the site with the caller''s rights; the 0351 trigger needs logistics.release.approve and stamps the time and person once.';

create or replace function app.add_marshalling_entry(p_project_id uuid, p_entry text, p_shipment_id uuid default null, p_zone_id uuid default null)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  insert into app.marshalling_log (project_id, entry, shipment_id, zone_id)
  values (p_project_id, btrim(p_entry), p_shipment_id, p_zone_id)
  returning id;
$$;

comment on function app.add_marshalling_entry(uuid, text, uuid, uuid) is 'Appends a marshalling yard log entry with the caller''s rights (logistics.yard.write on the project).';

revoke all on function app.check_in_dock_slot(uuid) from public, anon;
revoke all on function app.record_gate_arrival(uuid, text, uuid) from public, anon;
revoke all on function app.release_vehicle(uuid) from public, anon;
revoke all on function app.add_marshalling_entry(uuid, text, uuid, uuid) from public, anon;
grant execute on function app.check_in_dock_slot(uuid) to authenticated, service_role;
grant execute on function app.record_gate_arrival(uuid, text, uuid) to authenticated, service_role;
grant execute on function app.release_vehicle(uuid) to authenticated, service_role;
grant execute on function app.add_marshalling_entry(uuid, text, uuid, uuid) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.check_in_dock_slot', 'A dock lead checks a shipment in at its dock slot.'),
  ('app.record_gate_arrival', 'A yard marshal records a vehicle arriving at the site gate.'),
  ('app.release_vehicle', 'A yard lead releases a waiting vehicle into the site.'),
  ('app.add_marshalling_entry', 'A yard marshal adds an entry to the marshalling yard log.'),
  ('app.transition_fulfillment', 'A hospitality lead confirms, blocks or completes a fulfillment.')
on conflict (rpc) do nothing;
