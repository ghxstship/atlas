-- 0440_logistics_hospitality.sql
-- A11 Logistics and Hospitality (RRR-23, range 0440 to 0449, ADR 0022). Builds on A03's 0351 tables:
--   * display numbers {projectKey}-{n} for shipments, fulfillments, BEOs and accommodation blocks,
--     issued from the project's record sequence so a key names one thing in a project;
--   * dock slot check-in, stamped once by the database (journey 20);
--   * the fulfillment lifecycle (Proposed, Active, Blocked, Complete, Canceled) on the shared engine;
--   * accommodation blocks and room assignments, whose nightly occupancy never exceeds the rooms held;
--   * domain events for every logistics and hospitality change, which feed audit_events, the activity
--     feed and webhooks.

-- Display numbers -------------------------------------------------------------------------------------------

create or replace function private.issue_project_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_column text := tg_argv[0];
  v_new bigint := (to_jsonb(new) ->> v_column)::bigint;
begin
  if tg_op = 'INSERT' then
    return pg_catalog.jsonb_populate_record(new,
      pg_catalog.jsonb_build_object(v_column, private.next_sequence(new.org_id, 'project:' || new.project_id::text)));
  end if;
  if v_new is distinct from (to_jsonb(old) ->> v_column)::bigint then
    perform private.refuse('display_number_immutable', 'A row keeps its display key.');
  end if;
  if new.project_id <> old.project_id then
    perform private.refuse('project_immutable', 'A row stays in its project.');
  end if;
  return new;
end;
$$;

comment on function private.issue_project_number() is 'Before insert or update trigger: issues the row''s display number from the project''s record sequence (Section 4.5.1) and keeps the number and project fixed afterwards. Argument: number column.';
revoke all on function private.issue_project_number() from public, anon, authenticated;

alter table app.shipments add column shipment_number bigint not null default 0;
alter table app.fulfillments add column fulfillment_number bigint not null default 0;
alter table app.beos add column beo_number bigint not null default 0;

-- Existing rows take numbers in creation order before the uniqueness rule applies.
update app.shipments s set shipment_number = private.next_sequence(s.org_id, 'project:' || s.project_id::text)
from (select id from app.shipments order by created_at, id) o where o.id = s.id;
update app.fulfillments s set fulfillment_number = private.next_sequence(s.org_id, 'project:' || s.project_id::text)
from (select id from app.fulfillments order by created_at, id) o where o.id = s.id;
update app.beos s set beo_number = private.next_sequence(s.org_id, 'project:' || s.project_id::text)
from (select id from app.beos order by created_at, id) o where o.id = s.id;

create unique index shipments_project_number_key on app.shipments (project_id, shipment_number);
create unique index fulfillments_project_number_key on app.fulfillments (project_id, fulfillment_number);
create unique index beos_project_number_key on app.beos (project_id, beo_number);

create trigger t45_shipment_number before insert or update on app.shipments
  for each row execute function private.issue_project_number('shipment_number');
create trigger t45_fulfillment_number before insert or update on app.fulfillments
  for each row execute function private.issue_project_number('fulfillment_number');
create trigger t45_beo_number before insert or update on app.beos
  for each row execute function private.issue_project_number('beo_number');

comment on column app.shipments.shipment_number is 'Number within the project from the record sequence. The display key is {project_key}-{shipment_number}, read through app.shipment_display_key.';
comment on column app.fulfillments.fulfillment_number is 'Number within the project from the record sequence. The display key is {project_key}-{fulfillment_number}, read through app.fulfillment_display_key.';
comment on column app.beos.beo_number is 'Number within the project from the record sequence. The display key is {project_key}-{beo_number}, read through app.beo_display_key.';

create or replace function app.shipment_display_key(p_row app.shipments)
returns text language sql stable set search_path = ''
as $$ select p.project_key || '-' || p_row.shipment_number::text from app.projects p where p.id = p_row.project_id; $$;
comment on function app.shipment_display_key(app.shipments) is 'Computed field: the shipment''s display key {project_key}-{shipment_number}. Runs with the caller''s rights.';

create or replace function app.fulfillment_display_key(p_row app.fulfillments)
returns text language sql stable set search_path = ''
as $$ select p.project_key || '-' || p_row.fulfillment_number::text from app.projects p where p.id = p_row.project_id; $$;
comment on function app.fulfillment_display_key(app.fulfillments) is 'Computed field: the fulfillment''s display key {project_key}-{fulfillment_number}. Runs with the caller''s rights.';

create or replace function app.beo_display_key(p_row app.beos)
returns text language sql stable set search_path = ''
as $$ select p.project_key || '-' || p_row.beo_number::text from app.projects p where p.id = p_row.project_id; $$;
comment on function app.beo_display_key(app.beos) is 'Computed field: the BEO''s display key {project_key}-{beo_number}. Runs with the caller''s rights.';

-- Dock check-in ---------------------------------------------------------------------------------------------

alter table app.dock_slots
  add column checked_in_at timestamptz,
  add column checked_in_by uuid references app.people (id),
  add constraint dock_slots_check_in_pair check ((checked_in_at is null) = (checked_in_by is null));
create index dock_slots_checked_in_by_idx on app.dock_slots (checked_in_by);
comment on column app.dock_slots.checked_in_at is 'When the shipment checked in at the dock, stamped once with the database time.';
comment on column app.dock_slots.checked_in_by is 'Who checked the shipment in, stamped once with the session person.';

create or replace function private.guard_dock_check_in()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.checked_in_at is not null and (tg_op = 'INSERT' or old.checked_in_at is null) then
    if auth.uid() is not null and not (private.can_on_project(new.project_id, 'logistics.yard.write')
        or private.can_on_project(new.project_id, 'logistics.dock_slot.write')) then
      raise exception using errcode = '42501', message = 'logistics.yard.write is required to check in at a dock';
    end if;
    if new.deleted_at is not null then
      perform private.refuse('dock_slot_canceled', 'A canceled dock slot cannot be checked in.');
    end if;
    new.checked_in_at := now();
    new.checked_in_by := private.current_person_id();
  elsif tg_op = 'UPDATE' and old.checked_in_at is not null then
    if new.zone_id <> old.zone_id or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at
       or new.shipment_id is distinct from old.shipment_id then
      perform private.refuse('dock_slot_checked_in', 'A checked-in dock slot keeps its dock, window and shipment.');
    end if;
    new.checked_in_at := old.checked_in_at;
    new.checked_in_by := old.checked_in_by;
  end if;
  return new;
end;
$$;

comment on function private.guard_dock_check_in() is 'Dock check-in needs logistics.yard.write or logistics.dock_slot.write, is stamped once with the database time and session person, and freezes the slot''s dock, window and shipment.';
revoke all on function private.guard_dock_check_in() from public, anon, authenticated;
create trigger t41_guard_dock_check_in before insert or update on app.dock_slots
  for each row execute function private.guard_dock_check_in();

-- Fulfillment lifecycle -------------------------------------------------------------------------------------

create type app.fulfillment_state as enum ('Proposed', 'Active', 'Blocked', 'Complete', 'Canceled');
comment on type app.fulfillment_state is 'Fulfillment lifecycle in the shared commercial vocabulary (Section 3.10): Proposed while being arranged, Active once confirmed, Blocked with a reason, Complete once delivered, Canceled and retained.';

alter table app.fulfillments add column fulfillment_state app.fulfillment_state not null default 'Proposed';
comment on column app.fulfillments.fulfillment_state is 'Fulfillment lifecycle state. Changes only through app.transition_fulfillment.';
create index fulfillments_state_idx on app.fulfillments (project_id, fulfillment_state);

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('fulfillment', 'Proposed', 'Active'),
  ('fulfillment', 'Proposed', 'Canceled'),
  ('fulfillment', 'Active', 'Blocked'),
  ('fulfillment', 'Active', 'Complete'),
  ('fulfillment', 'Active', 'Canceled'),
  ('fulfillment', 'Blocked', 'Active'),
  ('fulfillment', 'Blocked', 'Canceled'),
  ('fulfillment', 'Complete', 'Active');

create table app.fulfillment_state_transitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  fulfillment_id uuid not null references app.fulfillments (id),
  from_state app.fulfillment_state,
  to_state app.fulfillment_state not null,
  reason text not null,
  constraint fulfillment_state_transitions_reason_length check (char_length(btrim(reason)) between 1 and 500)
);
create index fulfillment_state_transitions_fulfillment_idx on app.fulfillment_state_transitions (fulfillment_id);
call private.install_domain_table('app.fulfillment_state_transitions', 'app.fulfillments', 'fulfillment_id', '{}', true);
call private.install_policies('app.fulfillment_state_transitions',
  $$fulfillment_id in (select f.id from app.fulfillments f where f.project_id in (select private.project_ids_with('hospitality.fulfillment.read')))$$);
call private.describe('app.fulfillment_state_transitions', 'Append-only ledger of fulfillment state changes, written only by app.transition_fulfillment and fulfillment creation.', array[
  'fulfillment_id', 'Fulfillment that changed state.',
  'from_state', 'State before the change; NULL for the creation entry.',
  'to_state', 'State after the change.',
  'reason', 'Why the state changed.'
]);

-- Rows that existed before the lifecycle get their creation entry.
insert into app.fulfillment_state_transitions (org_id, fulfillment_id, from_state, to_state, reason)
select f.org_id, f.id, null, f.fulfillment_state, 'Created.' from app.fulfillments f;

create trigger t42_fulfillment_state before insert or update on app.fulfillments
  for each row execute function private.guard_lifecycle_state('fulfillment_state', 'fulfillment', 'Proposed');
create trigger t80_log_fulfillment_state after insert on app.fulfillments
  for each row execute function private.log_initial_state('app.fulfillment_state_transitions', 'fulfillment_id', 'fulfillment_state');
create trigger t90_emit_fulfillment_state after insert on app.fulfillment_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('fulfillment.state_changed', 'fulfillments', 'fulfillment_id', 'from_state', 'to_state', 'reason');

create or replace function app.transition_fulfillment(
  p_fulfillment_id uuid,
  p_expected app.fulfillment_state,
  p_next app.fulfillment_state,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select f.project_id from app.fulfillments f where f.id = p_fulfillment_id and f.deleted_at is null);
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'hospitality.fulfillment.write') then
    raise exception using errcode = '42501', message = 'hospitality.fulfillment.write is required';
  end if;
  return private.transition_lifecycle('fulfillment', 'app.fulfillments', 'fulfillment_state',
    'app.fulfillment_state_transitions', 'fulfillment_id', p_fulfillment_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_fulfillment(uuid, app.fulfillment_state, app.fulfillment_state, text) is 'Moves a fulfillment along Proposed, Active, Blocked, Complete, Canceled with compare-and-set and a reason. Needs hospitality.fulfillment.write on the project.';
revoke all on function app.transition_fulfillment(uuid, app.fulfillment_state, app.fulfillment_state, text) from public, anon;
grant execute on function app.transition_fulfillment(uuid, app.fulfillment_state, app.fulfillment_state, text) to authenticated, service_role;

create or replace function private.guard_fulfillment_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state app.fulfillment_state := (select f.fulfillment_state from app.fulfillments f where f.id = new.fulfillment_id);
begin
  if v_state in ('Complete', 'Canceled') then
    perform private.refuse('fulfillment_closed', format('A %s fulfillment''s lines no longer change; reopen it first.', v_state));
  end if;
  return new;
end;
$$;

comment on function private.guard_fulfillment_line() is 'Lines of a Complete or Canceled fulfillment never change.';
revoke all on function private.guard_fulfillment_line() from public, anon, authenticated;
create trigger t40_guard_fulfillment_line before insert or update on app.fulfillment_lines
  for each row execute function private.guard_fulfillment_line();

-- Accommodation blocks ----------------------------------------------------------------------------------------

create table app.accommodation_blocks (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  counterparty_id uuid references app.counterparties (id),
  title text not null,
  check_in_on date not null,
  check_out_on date not null,
  rooms_held integer not null,
  release_on date,
  nightly_rate_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  block_number bigint not null default 0,
  deleted_at timestamptz,
  constraint accommodation_blocks_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint accommodation_blocks_window check (check_out_on > check_in_on),
  constraint accommodation_blocks_rooms_positive check (rooms_held > 0),
  constraint accommodation_blocks_release_before_arrival check (release_on is null or release_on <= check_in_on),
  constraint accommodation_blocks_rate_currency check (nightly_rate_minor is null or currency_code is not null),
  constraint accommodation_blocks_rate_nonnegative check (nightly_rate_minor is null or nightly_rate_minor >= 0)
);
create index accommodation_blocks_project_id_idx on app.accommodation_blocks (project_id, check_in_on);
create index accommodation_blocks_counterparty_id_idx on app.accommodation_blocks (counterparty_id);
create index accommodation_blocks_currency_code_idx on app.accommodation_blocks (currency_code);
create unique index accommodation_blocks_project_number_key on app.accommodation_blocks (project_id, block_number);
call private.install_project_table('app.accommodation_blocks', 'hospitality.fulfillment.read', 'hospitality.accommodation.write', array['app.counterparties', 'counterparty_id']);
call private.describe('app.accommodation_blocks', 'Hotel room blocks contracted for a project: rooms held each night between check-in and check-out, released back to the hotel on the cutoff date. A NULL rate is unpriced.', array[
  'project_id', 'Project.', 'counterparty_id', 'Hotel or lodging supplier.', 'title', 'Block name, such as the hotel and purpose.',
  'check_in_on', 'First night held (hotel local date).', 'check_out_on', 'Departure date; the last night held is the day before.',
  'rooms_held', 'Rooms held on each night of the block.', 'release_on', 'Cutoff date when unassigned rooms return to the hotel.',
  'nightly_rate_minor', 'Contracted nightly rate in minor units; NULL is unpriced.', 'currency_code', 'ISO 4217 currency of the rate.',
  'block_number', 'Number within the project from the record sequence. The display key is {project_key}-{block_number}, read through app.accommodation_block_display_key.'
]);
create trigger t45_block_number before insert or update on app.accommodation_blocks
  for each row execute function private.issue_project_number('block_number');

create or replace function app.accommodation_block_display_key(p_row app.accommodation_blocks)
returns text language sql stable set search_path = ''
as $$ select p.project_key || '-' || p_row.block_number::text from app.projects p where p.id = p_row.project_id; $$;
comment on function app.accommodation_block_display_key(app.accommodation_blocks) is 'Computed field: the block''s display key {project_key}-{block_number}. Runs with the caller''s rights.';

create table app.accommodation_assignments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  accommodation_block_id uuid not null references app.accommodation_blocks (id),
  person_id uuid not null references app.people (id),
  check_in_on date not null,
  check_out_on date not null,
  deleted_at timestamptz,
  constraint accommodation_assignments_window check (check_out_on > check_in_on)
);
create index accommodation_assignments_block_idx on app.accommodation_assignments (accommodation_block_id, check_in_on);
create index accommodation_assignments_person_id_idx on app.accommodation_assignments (person_id);
call private.install_child_table('app.accommodation_assignments', 'app.accommodation_blocks', 'accommodation_block_id', 'hospitality.fulfillment.read', 'hospitality.accommodation.write');
call private.describe('app.accommodation_assignments', 'Room assignments of guests within an accommodation block. On any night, a block''s assignments never exceed its rooms held.', array[
  'accommodation_block_id', 'Block the room comes from.', 'person_id', 'Guest.',
  'check_in_on', 'Guest''s first night (inside the block).', 'check_out_on', 'Guest''s departure date (inside the block).'
]);

-- Peak nightly occupancy of a block, optionally ignoring one assignment and counting a proposed stay.
create or replace function private.block_peak_occupancy(p_block_id uuid, p_ignore uuid, p_from date, p_to date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(n.cnt), 0)::integer from (
    select d::date as night, count(a.id) as cnt
    from pg_catalog.generate_series(p_from, p_to - 1, interval '1 day') d
    left join app.accommodation_assignments a
      on a.accommodation_block_id = p_block_id and a.deleted_at is null
     and (p_ignore is null or a.id <> p_ignore)
     and d::date >= a.check_in_on and d::date < a.check_out_on
    group by d
  ) n;
$$;

comment on function private.block_peak_occupancy(uuid, uuid, date, date) is 'Highest number of live assignments of a block on any night from p_from to the night before p_to, ignoring one assignment. Takes the block id as an argument (ADR 0016, item 14).';
revoke all on function private.block_peak_occupancy(uuid, uuid, date, date) from public, anon, authenticated;

create or replace function private.guard_accommodation_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_block app.accommodation_blocks;
begin
  if new.deleted_at is not null then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('accommodation_blocks:' || new.accommodation_block_id::text, 0));
  select * into v_block from app.accommodation_blocks b where b.id = new.accommodation_block_id;
  if v_block.deleted_at is not null then
    perform private.refuse('accommodation_block_deleted', 'A deleted block takes no assignments.');
  end if;
  if new.check_in_on < v_block.check_in_on or new.check_out_on > v_block.check_out_on then
    perform private.refuse('accommodation_assignment_outside_block',
      format('A stay must fall within the block, %s to %s.', v_block.check_in_on, v_block.check_out_on));
  end if;
  if exists (select 1 from app.accommodation_assignments a
             where a.accommodation_block_id = new.accommodation_block_id and a.person_id = new.person_id
               and a.id <> new.id and a.deleted_at is null
               and daterange(a.check_in_on, a.check_out_on) && daterange(new.check_in_on, new.check_out_on)) then
    perform private.refuse('accommodation_assignment_duplicate', 'This guest already has a room in the block on those nights.');
  end if;
  if private.block_peak_occupancy(new.accommodation_block_id, new.id, new.check_in_on, new.check_out_on)
     + 1 > v_block.rooms_held then
    perform private.refuse('accommodation_block_full',
      format('Every one of the %s rooms is assigned on at least one of those nights.', v_block.rooms_held));
  end if;
  return new;
end;
$$;

comment on function private.guard_accommodation_assignment() is 'A room assignment falls within its block, never doubles a guest on the same nights, and never takes a block above its rooms held on any night.';
revoke all on function private.guard_accommodation_assignment() from public, anon, authenticated;
create trigger t40_guard_accommodation_assignment before insert or update on app.accommodation_assignments
  for each row execute function private.guard_accommodation_assignment();

create or replace function private.guard_accommodation_block()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('accommodation_blocks:' || new.id::text, 0));
  if new.deleted_at is null and exists (
    select 1 from app.accommodation_assignments a
    where a.accommodation_block_id = new.id and a.deleted_at is null
      and (a.check_in_on < new.check_in_on or a.check_out_on > new.check_out_on)) then
    perform private.refuse('accommodation_block_excludes_stays', 'The block must still cover every assigned stay.');
  end if;
  if new.deleted_at is null and private.block_peak_occupancy(new.id, null, new.check_in_on, new.check_out_on) > new.rooms_held then
    perform private.refuse('accommodation_block_full', 'More rooms are assigned on some night than the block would hold.');
  end if;
  return new;
end;
$$;

comment on function private.guard_accommodation_block() is 'A block''s window and rooms held always cover its live assignments.';
revoke all on function private.guard_accommodation_block() from public, anon, authenticated;
create trigger t40_guard_accommodation_block before update on app.accommodation_blocks
  for each row execute function private.guard_accommodation_block();

-- Domain events -----------------------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('shipment.created', 'shipments', 'A shipment was logged on a project.'),
  ('dock_slot.booked', 'dock_slots', 'A dock slot was booked at a loading dock.'),
  ('dock_slot.checked_in', 'dock_slots', 'A shipment checked in at its dock slot.'),
  ('gate_queue.arrived', 'gate_queue', 'A vehicle arrived at the site gate.'),
  ('gate_queue.released', 'gate_queue', 'A vehicle was released from the gate into the site.'),
  ('marshalling_log.entry_added', 'marshalling_log', 'An entry was added to the marshalling yard log.'),
  ('fulfillment.created', 'fulfillments', 'A lodging, catering, travel or amenity fulfillment was created.'),
  ('fulfillment.state_changed', 'fulfillments', 'A fulfillment moved to another fulfillment state.'),
  ('beo.created', 'beos', 'A banquet event order was generated.'),
  ('beo.approved', 'beos', 'A banquet event order was approved for issue.'),
  ('accommodation_block.created', 'accommodation_blocks', 'An accommodation block was contracted.'),
  ('accommodation_assignment.created', 'accommodation_assignments', 'A guest was assigned a room in an accommodation block.')
on conflict (code) do nothing;

create trigger t90_emit_shipment_created after insert on app.shipments
  for each row execute function private.emit_row_event('shipment.created', 'project_id', 'direction', 'shipment_number', 'arrives_at');
create trigger t90_emit_dock_slot_booked after insert on app.dock_slots
  for each row execute function private.emit_row_event('dock_slot.booked', 'project_id', 'zone_id', 'shipment_id', 'starts_at', 'ends_at');
create trigger t90_emit_dock_slot_checked_in after update of checked_in_at on app.dock_slots
  for each row when (old.checked_in_at is null and new.checked_in_at is not null)
  execute function private.emit_subject_event('dock_slot.checked_in', 'dock_slots', 'id', 'zone_id', 'shipment_id', 'checked_in_at');
create trigger t90_emit_gate_arrived after insert on app.gate_queue
  for each row execute function private.emit_row_event('gate_queue.arrived', 'project_id', 'shipment_id', 'vehicle_identifier', 'arrived_at');
create trigger t90_emit_gate_released after update of released_at on app.gate_queue
  for each row when (old.released_at is null and new.released_at is not null)
  execute function private.emit_subject_event('gate_queue.released', 'gate_queue', 'id', 'shipment_id', 'vehicle_identifier', 'released_at');
create trigger t90_emit_marshalling_entry after insert on app.marshalling_log
  for each row execute function private.emit_row_event('marshalling_log.entry_added', 'project_id', 'shipment_id', 'zone_id', 'logged_at');
create trigger t90_emit_fulfillment_created after insert on app.fulfillments
  for each row execute function private.emit_row_event('fulfillment.created', 'project_id', 'fulfillment_kind', 'fulfillment_number', 'starts_at');
create trigger t90_emit_beo_created after insert on app.beos
  for each row execute function private.emit_row_event('beo.created', 'project_id', 'fulfillment_id', 'beo_number', 'event_at', 'guest_count');
create trigger t90_emit_beo_approved after update of approved_at on app.beos
  for each row when (old.approved_at is null and new.approved_at is not null)
  execute function private.emit_subject_event('beo.approved', 'beos', 'id', 'approved_at');
create trigger t90_emit_block_created after insert on app.accommodation_blocks
  for each row execute function private.emit_row_event('accommodation_block.created', 'project_id', 'block_number', 'check_in_on', 'check_out_on', 'rooms_held');
create trigger t90_emit_assignment_created after insert on app.accommodation_assignments
  for each row execute function private.emit_row_event('accommodation_assignment.created', '-', 'accommodation_block_id', 'check_in_on', 'check_out_on');

-- Realtime and retention --------------------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table app.shipments, app.dock_slots, app.gate_queue, app.marshalling_log,
      app.fulfillments, app.beos, app.accommodation_blocks, app.accommodation_assignments;
  end if;
  -- On a fresh reset 0501 sweeps these tables into the retention policies; on a stack where 0501
  -- already ran, the default retention procedure from 0550 adds them.
  if to_regprocedure('private.install_default_retention(regclass, interval)') is not null then
    call private.install_default_retention('app.accommodation_blocks');
    call private.install_default_retention('app.accommodation_assignments');
    call private.install_default_retention('app.fulfillment_state_transitions');
  end if;
end;
$$;

-- Privileges -------------------------------------------------------------------------------------------------

revoke all on function app.shipment_display_key(app.shipments) from public, anon;
revoke all on function app.fulfillment_display_key(app.fulfillments) from public, anon;
revoke all on function app.beo_display_key(app.beos) from public, anon;
revoke all on function app.accommodation_block_display_key(app.accommodation_blocks) from public, anon;
grant execute on function app.shipment_display_key(app.shipments) to authenticated, service_role;
grant execute on function app.fulfillment_display_key(app.fulfillments) to authenticated, service_role;
grant execute on function app.beo_display_key(app.beos) to authenticated, service_role;
grant execute on function app.accommodation_block_display_key(app.accommodation_blocks) to authenticated, service_role;
