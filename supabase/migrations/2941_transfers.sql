-- 2941_transfers.sql
-- B5 Travel, lodging, ground transport and local contacts (RRR-229, ADR 0144; parity gap G-33). Ground transfers: one
-- vehicle run with a driver and a list of passengers, its own entity beside the travel segments, which keep one
-- traveller per row (0442). A pickup a planner books for a traveller is a transfer; a Ground segment still counts as
-- one (2942 recreates app.roster_travel_party for both).
--
--   * app.transfer_vehicles: the vehicles of a project, each with a type and the passenger seats it offers, and the car
--     service that supplies it. No plate is stored.
--   * app.transfers: pickup and drop-off places and times, each time in the zone it was typed in. The planner types the
--     drop-off estimate: arrival and drive times wait for a maps provider (G-34). transfer_number gives the display key
--     {project_key}-{transfer_number}, as 0440 does for blocks.
--   * app.transfer_passengers: who rides, one primary passenger at most.
--   * private.is_project_person: the people a transfer may carry or be driven by: an active member of the project's org,
--     the person of a live engagement of the project in Onboarding to Closing, or the person of a live roster entry (not
--     Withdrawn, not Declined) on such an engagement.
--   * Guards refuse with a rule key for each case below. Overlap checks take transaction advisory locks without
--     btree_gist (ADR 0104 section 6), in one fixed order to avoid deadlocks: the transfer, the driver, the vehicle, then
--     the passengers by ascending person id. A person has one lock key whether they drive or ride, so a driver who rides
--     elsewhere at the same time is caught either way.
-- Trash: app.transfers has no title column (private.trash_title_column), so a canceled transfer is restored in place
-- through @xos/data, its update policy reading deleted rows too; app.transfer_vehicles registers by label. Passengers go
-- with their transfer and are listed in private.trash_excluded_tables.

create type app.vehicle_type as enum ('Sedan', 'SUV', 'Van', 'Sprinter', 'Minibus', 'Coach', 'Other');
comment on type app.vehicle_type is 'Kind of vehicle a transfer runs in: Sedan, SUV, Van, Sprinter, Minibus, Coach or Other.';

-- Vehicles --------------------------------------------------------------------------------------------------------------

create table app.transfer_vehicles (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  counterparty_id uuid references app.counterparties (id),
  label text not null,
  vehicle_type app.vehicle_type not null,
  seats smallint not null,
  deleted_at timestamptz,
  constraint transfer_vehicles_label_length check (char_length(btrim(label)) between 1 and 60),
  constraint transfer_vehicles_seats check (seats between 1 and 80)
);

create index transfer_vehicles_project_id_idx on app.transfer_vehicles (project_id);
create index transfer_vehicles_counterparty_id_idx on app.transfer_vehicles (counterparty_id);
create unique index transfer_vehicles_label_key on app.transfer_vehicles (project_id, lower(label)) where deleted_at is null;

call private.install_project_table('app.transfer_vehicles', 'hospitality.fulfillment.read', 'hospitality.fulfillment.write',
  array['app.counterparties', 'counterparty_id']);
call private.describe('app.transfer_vehicles', 'Vehicles a project''s ground transfers run in (B5, G-33): a label the desk and drivers know it by, its type and passenger seats, and the car service that supplies it. No plate is stored.', array[
  'project_id', 'Project.',
  'counterparty_id', 'Car service or other supplier of the vehicle; NULL when the org runs it.',
  'label', 'Name the desk and drivers know the vehicle by, unique among the project''s live vehicles.',
  'vehicle_type', 'Sedan, SUV, Van, Sprinter, Minibus, Coach or Other.',
  'seats', 'Passenger seats, from 1 to 80; the driver is not counted.'
]);

-- Transfers -------------------------------------------------------------------------------------------------------------

create table app.transfers (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  transfer_number bigint not null default 0,
  fulfillment_id uuid references app.fulfillments (id),
  vehicle_id uuid references app.transfer_vehicles (id),
  driver_person_id uuid references app.people (id),
  pickup_place text not null,
  pickup_at timestamptz not null,
  pickup_time_zone text not null,
  dropoff_place text not null,
  dropoff_at timestamptz not null,
  dropoff_time_zone text not null,
  meets_travel_segment_id uuid references app.travel_segments (id),
  notes text,
  deleted_at timestamptz,
  constraint transfers_window check (dropoff_at > pickup_at),
  constraint transfers_places check (char_length(btrim(pickup_place)) between 1 and 200 and char_length(btrim(dropoff_place)) between 1 and 200),
  constraint transfers_notes_length check (notes is null or char_length(btrim(notes)) between 1 and 1000)
);

create index transfers_project_id_idx on app.transfers (project_id, pickup_at);
create index transfers_driver_person_id_idx on app.transfers (driver_person_id, pickup_at);
create index transfers_vehicle_id_idx on app.transfers (vehicle_id, pickup_at);
create index transfers_fulfillment_id_idx on app.transfers (fulfillment_id);
create index transfers_meets_travel_segment_id_idx on app.transfers (meets_travel_segment_id);
create unique index transfers_project_number_key on app.transfers (project_id, transfer_number);

call private.install_project_table('app.transfers', 'hospitality.fulfillment.read', 'hospitality.fulfillment.write',
  array['app.fulfillments', 'fulfillment_id', 'app.transfer_vehicles', 'vehicle_id', 'app.travel_segments', 'meets_travel_segment_id']);
call private.describe('app.transfers', 'Ground transfers of a project (B5, G-33): one vehicle run from a pickup to a drop-off, with its driver and passengers (app.transfer_passengers). Each time keeps the IANA zone it was typed in. The drop-off time is the planner''s estimate; no drive time is computed. Status is derived (app.transfer_board), never stored.', array[
  'project_id', 'Project.',
  'transfer_number', 'Number within the project from the record sequence. The display key is {project_key}-{transfer_number}, read through app.transfer_display_key.',
  'fulfillment_id', 'Travel fulfillment of the same project the transfer belongs to, when one does.',
  'vehicle_id', 'Vehicle of the same project; NULL while unassigned.',
  'driver_person_id', 'Driver: a member of the project''s org, or a person engaged or rostered on the project; NULL while unassigned.',
  'pickup_place', 'Pickup airport, hotel or address, as typed.',
  'pickup_at', 'Pickup instant.',
  'pickup_time_zone', 'IANA zone the pickup time was entered in.',
  'dropoff_place', 'Drop-off hotel, venue or address, as typed.',
  'dropoff_at', 'Drop-off instant, the planner''s estimate; after the pickup.',
  'dropoff_time_zone', 'IANA zone the drop-off time was entered in.',
  'meets_travel_segment_id', 'Flight of the same project the pickup meets, when it meets one.',
  'notes', 'Notes for the desk, never shown outside the org.'
]);

create trigger t45_transfer_number before insert or update on app.transfers
  for each row execute function private.issue_project_number('transfer_number');
create trigger t39_transfer_project before insert or update on app.transfers
  for each row execute function private.assert_same_project('app.fulfillments', 'fulfillment_id', 'app.transfer_vehicles', 'vehicle_id',
    'app.travel_segments', 'meets_travel_segment_id');

create or replace function app.transfer_display_key(p_row app.transfers)
returns text language sql stable set search_path = ''
as $$ select p.project_key || '-' || p_row.transfer_number::text from app.projects p where p.id = p_row.project_id; $$;
comment on function app.transfer_display_key(app.transfers) is 'Computed field: the transfer''s display key {project_key}-{transfer_number}. Runs with the caller''s rights.';

create table app.transfer_passengers (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  transfer_id uuid not null references app.transfers (id),
  person_id uuid not null references app.people (id),
  is_primary boolean not null default false,
  deleted_at timestamptz
);

create index transfer_passengers_transfer_id_idx on app.transfer_passengers (transfer_id);
create index transfer_passengers_person_id_idx on app.transfer_passengers (person_id);
create unique index transfer_passengers_person_key on app.transfer_passengers (transfer_id, person_id) where deleted_at is null;
create unique index transfer_passengers_primary_key on app.transfer_passengers (transfer_id) where is_primary and deleted_at is null;

call private.install_child_table('app.transfer_passengers', 'app.transfers', 'transfer_id', 'hospitality.fulfillment.read',
  'hospitality.fulfillment.write');
call private.describe('app.transfer_passengers', 'People riding a ground transfer, at most one of them primary (the person the run is for, named first to the driver).', array[
  'transfer_id', 'Transfer.',
  'person_id', 'Passenger: a member of the project''s org, or a person engaged or rostered on the project.',
  'is_primary', 'True for the passenger the run is for; at most one live passenger of a transfer.'
]);

-- Who rides and drives ------------------------------------------------------------------------------------------------

create or replace function private.is_project_person(p_project_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id is not null and (
    exists (
      select 1 from app.memberships m
      join app.projects p on p.id = p_project_id and p.org_id = m.org_id
      where m.person_id = p_person_id and m.deleted_at is null and m.valid_from <= now()
        and (m.valid_to is null or m.valid_to > now()))
    or exists (
      select 1 from app.engagements e
      where e.project_id = p_project_id and e.person_id = p_person_id and e.deleted_at is null
        and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing'))
    or exists (
      select 1 from private.roster_people rp
      join app.engagement_roster_entries r on r.id = rp.roster_entry_id
      join app.engagements e on e.id = r.engagement_id
      where rp.person_id = p_person_id and e.project_id = p_project_id and e.deleted_at is null
        and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
        and r.deleted_at is null and r.entry_state <> 'Withdrawn' and r.person_response <> 'Declined'));
$$;

comment on function private.is_project_person(uuid, uuid) is 'True when the person may ride or drive a transfer of the project: an active member of its org, the person of a live engagement of the project in Onboarding, Blocked, Active or Closing, or the person of a live roster entry (not Withdrawn, not Declined) on such an engagement.';
revoke all on function private.is_project_person(uuid, uuid) from public, anon, authenticated;

-- Another live transfer of the person (driving or riding) overlapping the window, other than p_ignore.
create or replace function private.transfer_person_busy(p_person_id uuid, p_ignore uuid, p_from timestamptz, p_to timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.transfers t
    where t.id <> p_ignore and t.deleted_at is null
      and tstzrange(t.pickup_at, t.dropoff_at) && tstzrange(p_from, p_to)
      and (t.driver_person_id = p_person_id or exists (
        select 1 from app.transfer_passengers x
        where x.transfer_id = t.id and x.person_id = p_person_id and x.deleted_at is null)));
$$;

comment on function private.transfer_person_busy(uuid, uuid, timestamptz, timestamptz) is 'True when the person drives or rides a live transfer, other than the one ignored, whose window overlaps the one given. Callers hold the person''s transfer_person lock.';
revoke all on function private.transfer_person_busy(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;

create or replace function private.lock_transfer_key(p_key text)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_key, 0));
$$;

comment on function private.lock_transfer_key(text) is 'Takes the transaction advisory lock of a transfer, person (transfer_person:) or vehicle (transfer_vehicle:) key.';
revoke all on function private.lock_transfer_key(text) from public, anon, authenticated;

create or replace function private.guard_transfer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recheck boolean;
  v_seats smallint;
  v_person uuid;
begin
  if new.deleted_at is not null then
    return new;
  end if;
  perform private.assert_time_zone(new.pickup_time_zone);
  perform private.assert_time_zone(new.dropoff_time_zone);
  v_recheck := tg_op = 'INSERT' or old.deleted_at is not null or new.pickup_at <> old.pickup_at or new.dropoff_at <> old.dropoff_at
    or new.vehicle_id is distinct from old.vehicle_id or new.driver_person_id is distinct from old.driver_person_id;

  perform private.lock_transfer_key('transfers:' || new.id::text);
  if new.fulfillment_id is not null and (select f.fulfillment_kind from app.fulfillments f where f.id = new.fulfillment_id) <> 'Travel' then
    perform private.refuse('travel_fulfillment_kind', 'A transfer belongs to a Travel fulfillment.');
  end if;
  if new.meets_travel_segment_id is not null and not exists (
      select 1 from app.travel_segments s
      where s.id = new.meets_travel_segment_id and s.project_id = new.project_id and s.deleted_at is null and s.travel_mode = 'Flight') then
    perform private.refuse('transfer_meets_flight', 'A pickup meets a live flight of the same project.');
  end if;

  if new.driver_person_id is not null then
    if not private.is_project_person(new.project_id, new.driver_person_id) then
      perform private.refuse('transfer_person_not_on_project', 'The driver works on this project: a member of the org, or a person engaged or rostered on it.');
    end if;
    if exists (select 1 from app.transfer_passengers x
               where x.transfer_id = new.id and x.person_id = new.driver_person_id and x.deleted_at is null) then
      perform private.refuse('transfer_driver_is_passenger', 'The driver cannot also ride as a passenger.');
    end if;
    perform private.lock_transfer_key('transfer_person:' || new.driver_person_id::text);
    if v_recheck and private.transfer_person_busy(new.driver_person_id, new.id, new.pickup_at, new.dropoff_at) then
      perform private.refuse('transfer_driver_double_booked', 'The driver is on another transfer at that time.');
    end if;
  end if;

  if new.vehicle_id is not null then
    perform private.lock_transfer_key('transfer_vehicle:' || new.vehicle_id::text);
    if v_recheck and exists (
        select 1 from app.transfers t
        where t.vehicle_id = new.vehicle_id and t.id <> new.id and t.deleted_at is null
          and tstzrange(t.pickup_at, t.dropoff_at) && tstzrange(new.pickup_at, new.dropoff_at)) then
      perform private.refuse('transfer_vehicle_double_booked', 'The vehicle is on another transfer at that time.');
    end if;
    select v.seats into v_seats from app.transfer_vehicles v where v.id = new.vehicle_id;
    if (select count(*) from app.transfer_passengers x where x.transfer_id = new.id and x.deleted_at is null) > v_seats then
      perform private.refuse('transfer_vehicle_full', format('The vehicle seats %s passengers.', v_seats));
    end if;
  end if;

  if v_recheck and tg_op = 'UPDATE' then
    for v_person in
      select x.person_id from app.transfer_passengers x
      where x.transfer_id = new.id and x.deleted_at is null
      order by x.person_id
    loop
      perform private.lock_transfer_key('transfer_person:' || v_person::text);
      if private.transfer_person_busy(v_person, new.id, new.pickup_at, new.dropoff_at) then
        perform private.refuse('transfer_passenger_double_booked', 'A passenger is on another transfer at that time.');
      end if;
    end loop;
  end if;
  return new;
end;
$$;

comment on function private.guard_transfer() is 'A live transfer''s zones are IANA zones, its fulfillment is a Travel fulfillment and the flight it meets a live Flight of the project; its driver works on the project and does not ride it. When it is created or restored, or its window, vehicle or driver changes, no person on it (driver or passenger) and not its vehicle is on another overlapping live transfer, and its vehicle seats its live passengers. Refusals: travel_fulfillment_kind, transfer_meets_flight, transfer_person_not_on_project, transfer_driver_is_passenger, transfer_driver_double_booked, transfer_vehicle_double_booked, transfer_vehicle_full, transfer_passenger_double_booked. Locks the transfer, then the driver, the vehicle and the passengers by ascending person id.';
revoke all on function private.guard_transfer() from public, anon, authenticated;
create trigger t40_guard_transfer before insert or update on app.transfers
  for each row execute function private.guard_transfer();

create or replace function private.guard_transfer_passenger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer app.transfers;
  v_seats smallint;
begin
  if new.deleted_at is not null then
    return new;
  end if;
  perform private.lock_transfer_key('transfers:' || new.transfer_id::text);
  select * into v_transfer from app.transfers t where t.id = new.transfer_id;
  if v_transfer.deleted_at is not null then
    perform private.refuse('transfer_canceled', 'A canceled transfer takes no passengers.');
  end if;
  if not private.is_project_person(v_transfer.project_id, new.person_id) then
    perform private.refuse('transfer_person_not_on_project', 'A passenger works on this project: a member of the org, or a person engaged or rostered on it.');
  end if;
  if new.person_id = v_transfer.driver_person_id then
    perform private.refuse('transfer_driver_is_passenger', 'The driver cannot also ride as a passenger.');
  end if;
  perform private.lock_transfer_key('transfer_person:' || new.person_id::text);
  if (tg_op = 'INSERT' or old.deleted_at is not null or new.person_id <> old.person_id)
     and private.transfer_person_busy(new.person_id, v_transfer.id, v_transfer.pickup_at, v_transfer.dropoff_at) then
    perform private.refuse('transfer_passenger_double_booked', 'This person is on another transfer at that time.');
  end if;
  if v_transfer.vehicle_id is not null then
    select v.seats into v_seats from app.transfer_vehicles v where v.id = v_transfer.vehicle_id;
    if (select count(*) from app.transfer_passengers x
        where x.transfer_id = new.transfer_id and x.deleted_at is null and x.id <> new.id) + 1 > v_seats then
      perform private.refuse('transfer_vehicle_full', format('The vehicle seats %s passengers.', v_seats));
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_transfer_passenger() is 'A live passenger rides a live transfer, works on its project, is not its driver, is on no other overlapping live transfer (driving or riding), and fits the vehicle''s seats. Refusals: transfer_canceled, transfer_person_not_on_project, transfer_driver_is_passenger, transfer_passenger_double_booked, transfer_vehicle_full. Locks the transfer, then the person.';
revoke all on function private.guard_transfer_passenger() from public, anon, authenticated;
create trigger t40_guard_transfer_passenger before insert or update on app.transfer_passengers
  for each row execute function private.guard_transfer_passenger();

create or replace function private.guard_transfer_vehicle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null and new.seats < old.seats then
    perform private.lock_transfer_key('transfer_vehicle:' || new.id::text);
    if exists (
        select 1 from app.transfers t
        where t.vehicle_id = new.id and t.deleted_at is null
          and (select count(*) from app.transfer_passengers x where x.transfer_id = t.id and x.deleted_at is null) > new.seats) then
      perform private.refuse('transfer_vehicle_full', format('A live transfer of this vehicle carries more than %s passengers.', new.seats));
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_transfer_vehicle() is 'A vehicle''s seats never drop below the live passengers of one of its live transfers (transfer_vehicle_full).';
revoke all on function private.guard_transfer_vehicle() from public, anon, authenticated;
create trigger t40_guard_transfer_vehicle before update on app.transfer_vehicles
  for each row execute function private.guard_transfer_vehicle();

-- Domain events, comments, Realtime, retention and Trash ---------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('transfer.created', 'transfers', 'A ground transfer was booked on a project.'),
  ('transfer.canceled', 'transfers', 'A ground transfer was canceled.'),
  ('transfer.driver_assigned', 'transfers', 'A driver was assigned to a ground transfer, or the driver changed.')
on conflict (code) do nothing;

create trigger t90_emit_transfer_created after insert on app.transfers
  for each row execute function private.emit_row_event('transfer.created', 'project_id', 'transfer_number', 'pickup_at', 'dropoff_at');
create trigger t90_emit_transfer_canceled after update of deleted_at on app.transfers
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_subject_event('transfer.canceled', 'transfers', 'id', 'transfer_number', 'pickup_at');
create trigger t90_emit_transfer_driver_assigned after update of driver_person_id on app.transfers
  for each row when (new.driver_person_id is not null and new.driver_person_id is distinct from old.driver_person_id)
  execute function private.emit_subject_event('transfer.driver_assigned', 'transfers', 'id', 'driver_person_id', 'pickup_at');

insert into private.comment_subjects (table_name) values ('app.transfers') on conflict do nothing;

do $$
declare
  v_table text;
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    foreach v_table in array array['transfers', 'transfer_passengers'] loop
      if not exists (select 1 from pg_catalog.pg_publication_tables p
                     where p.pubname = 'supabase_realtime' and p.schemaname = 'app' and p.tablename = v_table) then
        execute format('alter publication supabase_realtime add table app.%I', v_table);
      end if;
    end loop;
  end if;
end;
$$;

call private.install_default_retention('app.transfer_vehicles');
call private.install_default_retention('app.transfers');
call private.install_default_retention('app.transfer_passengers');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('transfer_passengers', 'A passenger goes with their transfer: removing one is undone by adding them again, and a canceled transfer is restored with its passengers.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();
