-- 0806_workforce_site_operations.sql
-- A29 Workforce Suite, production-specific additions (Section 4.9):
--   * Live occupancy counter: door counts against the permitted occupant load. The load is the space's
--     stated capacity, or its area divided by the occupant load factor from the Bible capacity metrics
--     (xpms.dim_metric domain capacity), or a permitted load from a permit. Alerts at 80, 90 and 100 percent
--     notify the project's dispatchers (safety.incident.dispatch) each time the count crosses a level upward.
--   * Weather monitoring: wind, lightning and heat thresholds per project at Monitor, Restrict and Evacuate.
--     The Bible has no weather action metrics yet, so each threshold names its source (the emergency plan
--     section it comes from). A reading that meets a level raises an alert to the canon roles the project
--     names for that level, through their role assignments; a reading below every level clears it.
--   * Guest list check-in at doors: approved guests of A10's guest list, with plus-ones admitted and an
--     optional credential scan, by holders of credentials.scan.write on the project.
--   * Lost and found log: items with photos (A18 attachments) and claim records.
-- Configuring counters and thresholds needs safety.emergency_code.write org-wide; counting, readings and
-- logging items need safety.incident.write on the project; claims are settled with safety.incident.close;
-- reading the log needs safety.incident.read on the project.

create type app.occupancy_load_basis as enum ('Space Capacity', 'Occupant Load Factor', 'Permit');
comment on type app.occupancy_load_basis is 'Where a counter''s permitted occupant load comes from: the space''s capacity, its area over the Bible occupant load factor, or a permit.';

create type app.weather_hazard as enum ('Wind', 'Lightning', 'Heat');
comment on type app.weather_hazard is 'Weather hazards monitored on site.';

create type app.weather_alert_level as enum ('Monitor', 'Restrict', 'Evacuate');
comment on type app.weather_alert_level is 'Weather action levels, in rising order: Monitor, Restrict, Evacuate.';

create type app.threshold_comparison as enum ('At or Above', 'At or Below');
comment on type app.threshold_comparison is 'How a reading meets a threshold: wind and heat at or above it, lightning distance at or below it.';

create type app.lost_item_category as enum ('Bag', 'Clothing', 'Electronics', 'Jewelry', 'Keys', 'Documents', 'Wallet', 'Other');
comment on type app.lost_item_category is 'Lost and found item categories.';

create type app.lost_item_state as enum ('Logged', 'Claimed', 'Returned', 'Disposed');
comment on type app.lost_item_state is 'Lost and found states: Logged (held), Claimed (a claim awaits verification), Returned and Disposed.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('lost_item', 'Logged', 'Claimed'),
  ('lost_item', 'Claimed', 'Logged'),
  ('lost_item', 'Claimed', 'Returned'),
  ('lost_item', 'Logged', 'Disposed');

insert into private.domain_event_types (code, subject, description) values
  ('occupancy.threshold_reached', 'occupancy_counters', 'A live occupancy count reached 80, 90 or 100 percent of the permitted load.'),
  ('weather_alert.raised', 'weather_alerts', 'A weather reading met a Monitor, Restrict or Evacuate threshold.'),
  ('weather_alert.cleared', 'weather_alerts', 'Weather readings fell below every threshold of a hazard.'),
  ('guest.checked_in_at_door', 'guest_check_ins', 'A guest was checked in at a door with their plus-ones.'),
  ('lost_item.logged', 'lost_found_items', 'A lost item was logged.'),
  ('lost_item.claimed', 'lost_found_claims', 'Someone claimed a lost item.'),
  ('lost_item.returned', 'lost_found_items', 'A lost item was returned to its verified owner.');

-- Who on a project receives site alerts: active project members holding the capability.
create or replace function private.project_member_people_with(p_project_id uuid, p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.person_id
  from app.project_members pm
  join app.memberships m on m.id = pm.membership_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  join app.projects p on p.id = pm.project_id
  where pm.project_id = p_project_id and pm.deleted_at is null and pm.valid_from <= now() and (pm.valid_to is null or pm.valid_to > now())
    and private.person_capability_reach(m.person_id, p.org_id, p_capability, true) is not null
  union
  select m.person_id
  from app.memberships m join app.projects p on p.id = p_project_id and p.org_id = m.org_id
  where m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    and private.person_capability_reach(m.person_id, p.org_id, p_capability, true) = 'organization';
$$;
comment on function private.project_member_people_with(uuid, text) is 'People who hold a capability on a project: its active members holding it at any reach, and members holding it org-wide.';
revoke all on function private.project_member_people_with(uuid, text) from public, anon, authenticated;

-- Occupancy -------------------------------------------------------------------------------------------------------

create table app.occupancy_counters (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  space_id uuid references app.spaces (id),
  name text not null,
  load_basis app.occupancy_load_basis not null,
  metric_domain text,
  metric_item text,
  permitted_load integer not null,
  current_count integer not null default 0,
  alert_level_percent smallint not null default 0,
  closed_at timestamptz,
  constraint occupancy_counters_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint occupancy_counters_load check (permitted_load > 0),
  constraint occupancy_counters_count check (current_count >= 0),
  constraint occupancy_counters_alert_level check (alert_level_percent in (0, 80, 90, 100)),
  constraint occupancy_counters_metric check ((load_basis = 'Occupant Load Factor') = (metric_item is not null)
    and (metric_item is null) = (metric_domain is null) and (metric_domain is null or metric_domain = 'capacity')),
  constraint occupancy_counters_space_basis check (load_basis = 'Permit' or space_id is not null),
  constraint occupancy_counters_metric_fkey foreign key (metric_domain, metric_item) references xpms.dim_metric (domain, item)
);
create index occupancy_counters_project_idx on app.occupancy_counters (project_id);
create index occupancy_counters_space_idx on app.occupancy_counters (space_id);
create index occupancy_counters_metric_idx on app.occupancy_counters (metric_domain, metric_item);
call private.install_domain_table('app.occupancy_counters', 'app.projects', 'project_id', array['app.spaces', 'space_id']);
call private.describe('app.occupancy_counters', 'A live occupancy counter (Section 4.9) for a space or entrance on a project: the current count against the permitted occupant load, with alerts at 80, 90 and 100 percent.', array[
  'project_id', 'Project the counter runs on.',
  'space_id', 'Space counted; required unless the load comes from a permit.',
  'name', 'Counter name, for example Main Floor.',
  'load_basis', 'Space Capacity, Occupant Load Factor or Permit.',
  'metric_domain', 'Bible metric domain of the load factor (capacity).',
  'metric_item', 'Bible occupant load factor used, for example Assembly - standing space.',
  'permitted_load', 'Permitted occupant load.',
  'current_count', 'People inside now, kept by the door counts.',
  'alert_level_percent', 'Highest alert level (80, 90 or 100) the count currently meets; 0 below 80.',
  'closed_at', 'When counting stopped.'
]);
call private.install_policies('app.occupancy_counters', $$project_id in (select private.project_ids_with('safety.incident.read'))$$);

create table app.occupancy_counts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  occupancy_counter_id uuid not null references app.occupancy_counters (id),
  delta integer not null,
  door text,
  counted_by_membership_id uuid references app.memberships (id),
  count_after integer not null,
  constraint occupancy_counts_delta check (delta <> 0 and delta between -500 and 500),
  constraint occupancy_counts_door_length check (door is null or char_length(btrim(door)) between 1 and 80),
  constraint occupancy_counts_after check (count_after >= 0)
);
create index occupancy_counts_counter_idx on app.occupancy_counts (occupancy_counter_id);
create index occupancy_counts_counter_by_idx on app.occupancy_counts (counted_by_membership_id);
call private.install_domain_table('app.occupancy_counts', 'app.occupancy_counters', 'occupancy_counter_id',
  array['app.memberships', 'counted_by_membership_id'], true);
call private.describe('app.occupancy_counts', 'Append-only door counts: people in (positive) and out (negative), with the count after each.', array[
  'occupancy_counter_id', 'Counter.',
  'delta', 'People in (positive) or out (negative).',
  'door', 'Door or gate counted at.',
  'counted_by_membership_id', 'Member who counted.',
  'count_after', 'Count after this entry.'
]);
call private.install_policies('app.occupancy_counts',
  $$exists (select 1 from app.occupancy_counters c where c.id = occupancy_counter_id and c.project_id in (select private.project_ids_with('safety.incident.read')))$$);

create or replace function app.create_occupancy_counter(
  p_project_id uuid,
  p_name text,
  p_space_id uuid default null,
  p_metric_item text default null,
  p_permitted_load integer default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select p.org_id from app.projects p where p.id = p_project_id and p.deleted_at is null);
  v_space app.spaces;
  v_factor numeric;
  v_basis app.occupancy_load_basis;
  v_load integer;
  v_id uuid;
begin
  perform private.require_person();
  if v_org is null or not private.has_capability(v_org, 'safety.emergency_code.write') or p_project_id not in (select private.readable_project_ids()) then
    raise exception using errcode = '42501', message = 'configuring occupancy counters needs safety.emergency_code.write';
  end if;
  if p_space_id is not null then
    select * into v_space from app.spaces s where s.id = p_space_id and s.org_id = v_org and s.deleted_at is null;
    if v_space.id is null then
      perform private.refuse('occupancy_space', 'The space is not in this org.');
    end if;
  end if;
  if p_permitted_load is not null then
    v_basis := 'Permit';
    v_load := p_permitted_load;
  elsif p_metric_item is not null then
    if v_space.area_sq_ft is null then
      perform private.refuse('occupancy_space_area', 'The space needs its area before a load factor can size it.');
    end if;
    select m.value_numeric into v_factor from xpms.dim_metric m where m.domain = 'capacity' and m.item = p_metric_item;
    if v_factor is null or v_factor <= 0 or p_metric_item in ('Exits required', 'Min egress door width (in)', 'Crowd managers required') then
      perform private.refuse('occupancy_load_factor', 'Pick an occupant load factor from the Bible capacity metrics.');
    end if;
    v_basis := 'Occupant Load Factor';
    v_load := floor(v_space.area_sq_ft / v_factor)::integer;
  elsif v_space.capacity is not null then
    v_basis := 'Space Capacity';
    v_load := v_space.capacity;
  else
    perform private.refuse('occupancy_load_unknown', 'Give the permitted load, pick a load factor, or set the space''s capacity first.');
  end if;
  if v_load < 1 then
    perform private.refuse('occupancy_load_unknown', 'The permitted load works out below one person; check the area and factor.');
  end if;
  insert into app.occupancy_counters (project_id, space_id, name, load_basis, metric_domain, metric_item, permitted_load)
  values (p_project_id, p_space_id, btrim(p_name), v_basis, case when v_basis = 'Occupant Load Factor' then 'capacity' end,
    case when v_basis = 'Occupant Load Factor' then p_metric_item end, v_load)
  returning id into v_id;
  return v_id;
end;
$$;
comment on function app.create_occupancy_counter(uuid, text, uuid, text, integer) is 'Sets up an occupancy counter on a project (safety.emergency_code.write). The permitted load is p_permitted_load from a permit, or the space''s area over the Bible occupant load factor p_metric_item, or the space''s capacity. Returns the counter id.';
revoke all on function app.create_occupancy_counter(uuid, text, uuid, text, integer) from public, anon;
grant execute on function app.create_occupancy_counter(uuid, text, uuid, text, integer) to authenticated, service_role;

create or replace function private.guard_occupancy_counter()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.current_count <> 0 or new.alert_level_percent <> 0 or new.closed_at is not null then
      perform private.refuse('occupancy_counter_initial', 'A counter starts open at zero.');
    end if;
    return new;
  end if;
  if (new.current_count <> old.current_count or new.alert_level_percent <> old.alert_level_percent)
     and not private.in_trusted_operation('count_occupancy') then
    perform private.refuse('occupancy_count_rpc', 'The count changes only through door counts.');
  end if;
  if new.project_id <> old.project_id or new.space_id is distinct from old.space_id or new.load_basis <> old.load_basis
     or new.permitted_load <> old.permitted_load or new.metric_item is distinct from old.metric_item then
    perform private.refuse('occupancy_counter_fixed', 'A counter keeps its space and permitted load; close it and set up a new one.');
  end if;
  if old.closed_at is not null and new.closed_at is distinct from old.closed_at then
    perform private.refuse('occupancy_counter_closed', 'A closed counter stays closed.');
  end if;
  return new;
end;
$$;
comment on function private.guard_occupancy_counter() is 'Occupancy counters start open at zero, change count only through door counts, keep their space and load, and close for good.';
revoke all on function private.guard_occupancy_counter() from public, anon, authenticated;
create trigger t42_guard_occupancy_counter before insert or update on app.occupancy_counters
  for each row execute function private.guard_occupancy_counter();

create or replace function app.close_occupancy_counter(p_counter_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_counter app.occupancy_counters;
begin
  perform private.require_person();
  select * into v_counter from app.occupancy_counters c where c.id = p_counter_id and c.deleted_at is null;
  if v_counter.id is null or not private.has_capability(v_counter.org_id, 'safety.emergency_code.write') then
    raise exception using errcode = '42501', message = 'closing occupancy counters needs safety.emergency_code.write';
  end if;
  update app.occupancy_counters set closed_at = coalesce(closed_at, now()) where id = p_counter_id;
  return p_counter_id;
end;
$$;
comment on function app.close_occupancy_counter(uuid) is 'Stops an occupancy counter (safety.emergency_code.write); its counts stay. Returns the counter id.';
revoke all on function app.close_occupancy_counter(uuid) from public, anon;
grant execute on function app.close_occupancy_counter(uuid) to authenticated, service_role;

create or replace function app.record_occupancy_count(p_counter_id uuid, p_delta integer, p_door text default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_counter app.occupancy_counters;
  v_after integer;
  v_percent numeric;
  v_level smallint;
  v_person uuid;
begin
  perform private.require_person();
  select * into v_counter from app.occupancy_counters c where c.id = p_counter_id and c.deleted_at is null for update;
  if v_counter.id is null or not private.can_on_project(v_counter.project_id, 'safety.incident.write') then
    raise exception using errcode = '42501', message = 'counting needs safety.incident.write on the project';
  end if;
  if v_counter.closed_at is not null then
    perform private.refuse('occupancy_counter_closed', 'This counter is closed.');
  end if;
  v_after := v_counter.current_count + p_delta;
  if v_after < 0 then
    perform private.refuse('occupancy_count_negative', format('Only %s people are counted inside; check the door count.', v_counter.current_count));
  end if;
  insert into app.occupancy_counts (occupancy_counter_id, delta, door, counted_by_membership_id, count_after)
  values (p_counter_id, p_delta, nullif(btrim(p_door), ''), private.my_membership_in(v_counter.org_id), v_after);
  v_percent := 100.0 * v_after / v_counter.permitted_load;
  v_level := case when v_percent >= 100 then 100 when v_percent >= 90 then 90 when v_percent >= 80 then 80 else 0 end;
  perform private.begin_trusted_operation('count_occupancy');
  update app.occupancy_counters set current_count = v_after, alert_level_percent = v_level where id = p_counter_id;
  perform private.end_trusted_operation('count_occupancy');
  if v_level > v_counter.alert_level_percent then
    perform private.emit_event(v_counter.org_id, 'occupancy.threshold_reached', 'occupancy_counters', p_counter_id, v_counter.project_id,
      jsonb_build_object('percent', v_level, 'count', v_after, 'permitted_load', v_counter.permitted_load));
    for v_person in select private.project_member_people_with(v_counter.project_id, 'safety.incident.dispatch') loop
      perform private.notify(v_counter.org_id, v_person, 'occupancy.threshold', 'app.occupancy_counters', p_counter_id, v_counter.project_id,
        jsonb_build_object('title', v_counter.name, 'percent', v_level, 'count', v_after, 'permitted_load', v_counter.permitted_load));
    end loop;
  end if;
  return v_after;
end;
$$;
comment on function app.record_occupancy_count(uuid, integer, text) is 'Counts people in (positive) or out (negative) at a door (safety.incident.write on the project). The count never goes below zero. Crossing 80, 90 or 100 percent of the permitted load upward alerts the project''s dispatchers. Returns the new count.';
revoke all on function app.record_occupancy_count(uuid, integer, text) from public, anon;
grant execute on function app.record_occupancy_count(uuid, integer, text) to authenticated, service_role;

-- Weather -----------------------------------------------------------------------------------------------------------------

create table app.weather_thresholds (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  hazard app.weather_hazard not null,
  alert_level app.weather_alert_level not null,
  threshold_value numeric not null,
  unit text not null,
  comparison app.threshold_comparison not null,
  source_note text not null,
  constraint weather_thresholds_unit check ((hazard = 'Wind' and unit = 'mph') or (hazard = 'Lightning' and unit = 'mi') or (hazard = 'Heat' and unit = 'F')),
  constraint weather_thresholds_comparison check ((hazard = 'Lightning') = (comparison = 'At or Below')),
  constraint weather_thresholds_value check (threshold_value >= 0 and threshold_value <= 200),
  constraint weather_thresholds_source_length check (char_length(btrim(source_note)) between 1 and 300)
);
call private.install_domain_table('app.weather_thresholds', 'app.projects', 'project_id');
create unique index weather_thresholds_key on app.weather_thresholds (project_id, hazard, alert_level) where deleted_at is null;
call private.describe('app.weather_thresholds', 'Weather action thresholds of a project (Section 4.9 Weather monitoring): one value per hazard and level, with the emergency plan source it comes from.', array[
  'project_id', 'Project.',
  'hazard', 'Wind, Lightning or Heat.',
  'alert_level', 'Monitor, Restrict or Evacuate.',
  'threshold_value', 'Value that triggers the level.',
  'unit', 'mph for wind gusts, mi for lightning distance, F for heat index.',
  'comparison', 'At or Above for wind and heat, At or Below for lightning distance.',
  'source_note', 'Where the value comes from, for example the emergency plan section.'
]);
call private.install_policies('app.weather_thresholds',
  $$project_id in (select private.project_ids_with('safety.incident.read'))$$,
  $$org_id in (select private.orgs_with_capability('safety.emergency_code.write')) and project_id in (select private.readable_project_ids())$$);

create table app.weather_alert_roles (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  alert_level app.weather_alert_level not null,
  role_code text not null references xpms.dim_role (role_code)
);
create index weather_alert_roles_role_idx on app.weather_alert_roles (role_code);
call private.install_domain_table('app.weather_alert_roles', 'app.projects', 'project_id');
create unique index weather_alert_roles_key on app.weather_alert_roles (project_id, alert_level, role_code) where deleted_at is null;
call private.describe('app.weather_alert_roles', 'The canon roles the project''s emergency plan names for each weather level; the people assigned those roles on the project receive the alerts.', array[
  'project_id', 'Project.',
  'alert_level', 'Monitor, Restrict or Evacuate.',
  'role_code', 'Canon role notified at that level.'
]);
call private.install_policies('app.weather_alert_roles',
  $$project_id in (select private.project_ids_with('safety.incident.read'))$$,
  $$org_id in (select private.orgs_with_capability('safety.emergency_code.write')) and project_id in (select private.readable_project_ids())$$);

create table app.weather_readings (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  hazard app.weather_hazard not null,
  reading_value numeric not null,
  observed_at timestamptz not null default now(),
  recorded_by_membership_id uuid references app.memberships (id),
  constraint weather_readings_value check (reading_value >= 0 and reading_value <= 200),
  constraint weather_readings_observed check (observed_at <= now() + interval '5 minutes')
);
create index weather_readings_project_idx on app.weather_readings (project_id, hazard, observed_at desc);
create index weather_readings_recorder_idx on app.weather_readings (recorded_by_membership_id);
call private.install_domain_table('app.weather_readings', 'app.projects', 'project_id', array['app.memberships', 'recorded_by_membership_id'], true);
call private.describe('app.weather_readings', 'Append-only weather readings on site, in the hazard''s unit (mph, mi, F).', array[
  'project_id', 'Project.',
  'hazard', 'Wind, Lightning or Heat.',
  'reading_value', 'Reading in the hazard''s unit.',
  'observed_at', 'When it was observed.',
  'recorded_by_membership_id', 'Member who recorded it.'
]);
call private.install_policies('app.weather_readings', $$project_id in (select private.project_ids_with('safety.incident.read'))$$);

create table app.weather_alerts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  hazard app.weather_hazard not null,
  alert_level app.weather_alert_level not null,
  weather_reading_id uuid not null references app.weather_readings (id),
  issued_at timestamptz not null default now(),
  cleared_at timestamptz,
  constraint weather_alerts_cleared check (cleared_at is null or cleared_at >= issued_at)
);
create index weather_alerts_project_idx on app.weather_alerts (project_id, hazard, issued_at desc);
create index weather_alerts_reading_idx on app.weather_alerts (weather_reading_id);
create unique index weather_alerts_active_key on app.weather_alerts (project_id, hazard) where cleared_at is null;
call private.install_domain_table('app.weather_alerts', 'app.projects', 'project_id', array['app.weather_readings', 'weather_reading_id']);
call private.describe('app.weather_alerts', 'Weather alerts raised by readings: one active alert per hazard at the highest level met, cleared when a reading falls below every level.', array[
  'project_id', 'Project.',
  'hazard', 'Hazard alerted.',
  'alert_level', 'Level met.',
  'weather_reading_id', 'Reading that raised it.',
  'issued_at', 'When it was raised.',
  'cleared_at', 'When it cleared or a new level replaced it.'
]);
call private.install_policies('app.weather_alerts', $$project_id in (select private.project_ids_with('safety.incident.read'))$$);

create or replace function app.record_weather_reading(p_project_id uuid, p_hazard app.weather_hazard, p_value numeric, p_observed_at timestamptz default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select p.org_id from app.projects p where p.id = p_project_id and p.deleted_at is null);
  v_reading uuid;
  v_level app.weather_alert_level;
  v_active app.weather_alerts;
  v_alert uuid;
  v_person uuid;
begin
  perform private.require_person();
  if v_org is null or not private.can_on_project(p_project_id, 'safety.incident.write') then
    raise exception using errcode = '42501', message = 'recording weather needs safety.incident.write on the project';
  end if;
  insert into app.weather_readings (project_id, hazard, reading_value, observed_at, recorded_by_membership_id)
  values (p_project_id, p_hazard, p_value, coalesce(p_observed_at, now()), private.my_membership_in(v_org))
  returning id into v_reading;
  select t.alert_level into v_level from app.weather_thresholds t
  where t.project_id = p_project_id and t.hazard = p_hazard and t.deleted_at is null
    and ((t.comparison = 'At or Above' and p_value >= t.threshold_value) or (t.comparison = 'At or Below' and p_value <= t.threshold_value))
  order by t.alert_level desc limit 1;
  select * into v_active from app.weather_alerts a where a.project_id = p_project_id and a.hazard = p_hazard and a.cleared_at is null;
  if v_level is not distinct from v_active.alert_level then
    return v_reading;
  end if;
  if v_active.id is not null then
    update app.weather_alerts set cleared_at = now() where id = v_active.id;
    if v_level is null then
      perform private.emit_event(v_org, 'weather_alert.cleared', 'weather_alerts', v_active.id, p_project_id,
        jsonb_build_object('hazard', p_hazard, 'reading', p_value));
    end if;
  end if;
  if v_level is not null then
    insert into app.weather_alerts (project_id, hazard, alert_level, weather_reading_id) values (p_project_id, p_hazard, v_level, v_reading)
    returning id into v_alert;
    perform private.emit_event(v_org, 'weather_alert.raised', 'weather_alerts', v_alert, p_project_id,
      jsonb_build_object('hazard', p_hazard, 'level', v_level, 'reading', p_value));
    for v_person in
      select distinct ra.person_id from app.role_assignments ra
      join app.weather_alert_roles r on r.project_id = ra.project_id and r.role_code = ra.role_code and r.deleted_at is null and r.alert_level = v_level
      where ra.project_id = p_project_id and ra.person_id is not null and ra.deleted_at is null
      union
      select private.project_member_people_with(p_project_id, 'safety.incident.dispatch')
    loop
      perform private.notify(v_org, v_person, 'weather.alert', 'app.weather_alerts', v_alert, p_project_id,
        jsonb_build_object('hazard', p_hazard, 'level', v_level, 'reading', p_value));
    end loop;
  end if;
  return v_reading;
end;
$$;
comment on function app.record_weather_reading(uuid, app.weather_hazard, numeric, timestamptz) is 'Records a weather reading on a project (safety.incident.write). The highest Monitor, Restrict or Evacuate threshold it meets raises an alert to the canon roles named for that level and the project''s dispatchers; a reading below every level clears the hazard''s alert. Returns the reading id.';
revoke all on function app.record_weather_reading(uuid, app.weather_hazard, numeric, timestamptz) from public, anon;
grant execute on function app.record_weather_reading(uuid, app.weather_hazard, numeric, timestamptz) to authenticated, service_role;

-- Guest check-in at doors ---------------------------------------------------------------------------------------------------

create table app.guest_check_ins (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  guest_list_entry_id uuid not null references app.guest_list_entries (id),
  plus_ones_admitted smallint not null default 0,
  credential_id uuid references app.credentials (id),
  door text,
  checked_in_by_membership_id uuid references app.memberships (id),
  constraint guest_check_ins_plus_ones check (plus_ones_admitted between 0 and 50),
  constraint guest_check_ins_door_length check (door is null or char_length(btrim(door)) between 1 and 80)
);
create unique index guest_check_ins_entry_key on app.guest_check_ins (guest_list_entry_id);
create index guest_check_ins_credential_idx on app.guest_check_ins (credential_id);
create index guest_check_ins_checker_idx on app.guest_check_ins (checked_in_by_membership_id);
call private.install_domain_table('app.guest_check_ins', 'app.guest_list_entries', 'guest_list_entry_id',
  array['app.credentials', 'credential_id', 'app.memberships', 'checked_in_by_membership_id'], true);
call private.describe('app.guest_check_ins', 'Append-only door check-ins of guest list entries (Section 4.9), with plus-ones admitted and the credential scanned.', array[
  'guest_list_entry_id', 'Guest list entry checked in.',
  'plus_ones_admitted', 'Plus-ones admitted with the guest, never more than the entry allows.',
  'credential_id', 'Credential scanned at the door, when one was.',
  'door', 'Door or gate.',
  'checked_in_by_membership_id', 'Door staff member who checked the guest in.'
]);
call private.install_policies('app.guest_check_ins',
  $$exists (select 1 from app.guest_list_entries g where g.id = guest_list_entry_id
            and g.project_id in (select private.project_ids_with('credentials.scan.write')))$$);

create or replace function app.door_guest_list(p_project_id uuid, p_search text default null)
returns table (
  guest_list_entry_id uuid,
  guest_name text,
  plus_ones smallint,
  entry_state app.guest_entry_state,
  note text,
  checked_in_at timestamptz,
  plus_ones_admitted smallint,
  door text
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
    select g.id, g.guest_name, g.plus_ones, g.entry_state, g.note, g.checked_in_at, c.plus_ones_admitted, c.door
    from app.guest_list_entries g
    left join app.guest_check_ins c on c.guest_list_entry_id = g.id
    where g.project_id = p_project_id and g.deleted_at is null and g.entry_state in ('Approved', 'Checked In')
      and (coalesce(btrim(p_search), '') = '' or g.guest_name ilike '%' || btrim(p_search) || '%')
    order by g.entry_state, g.guest_name;
end;
$$;
comment on function app.door_guest_list(uuid, text) is 'The door list of a project for door staff (credentials.scan.write): approved and checked-in guests with plus-ones, filtered by name.';
revoke all on function app.door_guest_list(uuid, text) from public, anon;
grant execute on function app.door_guest_list(uuid, text) to authenticated, service_role;

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
  return v_id;
end;
$$;
comment on function app.check_in_guest(uuid, smallint, text, text) is 'Checks an approved guest in at a door (credentials.scan.write on the project) with up to their listed plus-ones and an optional credential scan, which must be valid now, on the project and the guest''s own. Returns the check-in id.';
revoke all on function app.check_in_guest(uuid, smallint, text, text) from public, anon;
grant execute on function app.check_in_guest(uuid, smallint, text, text) to authenticated, service_role;

-- Lost and found ----------------------------------------------------------------------------------------------------------------

create table app.lost_found_items (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  item_number text not null,
  category app.lost_item_category not null,
  description text not null,
  found_at timestamptz not null default now(),
  found_location text not null,
  storage_location text,
  logged_by_membership_id uuid references app.memberships (id),
  item_state app.lost_item_state not null default 'Logged',
  constraint lost_found_items_number_format check (item_number ~ '^LF-[0-9]{4,}$'),
  constraint lost_found_items_description_length check (char_length(btrim(description)) between 1 and 1000),
  constraint lost_found_items_found_location_length check (char_length(btrim(found_location)) between 1 and 200),
  constraint lost_found_items_storage_length check (storage_location is null or char_length(btrim(storage_location)) between 1 and 200),
  constraint lost_found_items_found_at check (found_at <= now() + interval '5 minutes')
);
create unique index lost_found_items_number_key on app.lost_found_items (org_id, item_number);
create index lost_found_items_project_idx on app.lost_found_items (project_id, item_state);
create index lost_found_items_logger_idx on app.lost_found_items (logged_by_membership_id);
call private.install_domain_table('app.lost_found_items', 'app.projects', 'project_id', array['app.memberships', 'logged_by_membership_id']);
call private.describe('app.lost_found_items', 'The lost and found log (Section 4.9): items found on site, with photos as attachments, where they are stored and their claim state.', array[
  'project_id', 'Project the item was found on.',
  'item_number', 'Display number, LF-0001 upward per org.',
  'category', 'What kind of item it is.',
  'description', 'Description a claimant can be checked against.',
  'found_at', 'When it was found.',
  'found_location', 'Where it was found.',
  'storage_location', 'Where it is held.',
  'logged_by_membership_id', 'Member who logged it.',
  'item_state', 'Logged, Claimed, Returned or Disposed.'
]);
call private.install_policies('app.lost_found_items',
  $$project_id in (select private.project_ids_with('safety.incident.read'))$$,
  null,
  $$project_id in (select private.project_ids_with('safety.incident.write'))$$);

call private.install_lifecycle('app.lost_found_items', 'lost_found_item_id', 'item_state', 'lost_item', 'Logged',
  $$exists (select 1 from app.lost_found_items i where i.id = lost_found_item_id and i.project_id in (select private.project_ids_with('safety.incident.read')))$$);

create or replace function private.guard_lost_found_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and not private.in_trusted_operation('log_lost_item') then
    perform private.refuse('lost_item_rpc', 'Lost items are logged through app.log_lost_item.');
  end if;
  if tg_op = 'UPDATE' and (new.item_number <> old.item_number or new.found_at <> old.found_at or new.project_id <> old.project_id
     or new.logged_by_membership_id is distinct from old.logged_by_membership_id) then
    perform private.refuse('lost_item_fixed', 'A logged item keeps its number, project, finder and found time.');
  end if;
  return new;
end;
$$;
comment on function private.guard_lost_found_item() is 'Lost items are logged only through app.log_lost_item and keep their number, project, logger and found time; description, category and storage stay editable.';
revoke all on function private.guard_lost_found_item() from public, anon, authenticated;
create trigger t42_guard_lost_found_item before insert or update on app.lost_found_items
  for each row execute function private.guard_lost_found_item();

create table app.lost_found_claims (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  lost_found_item_id uuid not null references app.lost_found_items (id),
  claimant_name text not null,
  claimant_contact text not null,
  proof_description text not null,
  recorded_by_membership_id uuid references app.memberships (id),
  decided_by_membership_id uuid references app.memberships (id),
  decided_at timestamptz,
  returned boolean,
  decision_note text,
  constraint lost_found_claims_name_length check (char_length(btrim(claimant_name)) between 1 and 200),
  constraint lost_found_claims_contact_length check (char_length(btrim(claimant_contact)) between 3 and 200),
  constraint lost_found_claims_proof_length check (char_length(btrim(proof_description)) between 1 and 1000),
  constraint lost_found_claims_decision check ((decided_at is null) = (returned is null) and (decided_at is null) = (decided_by_membership_id is null)),
  constraint lost_found_claims_note_length check (decision_note is null or char_length(btrim(decision_note)) between 1 and 500),
  constraint lost_found_claims_rejection_note check (returned is distinct from false or decision_note is not null)
);
create index lost_found_claims_item_idx on app.lost_found_claims (lost_found_item_id);
create index lost_found_claims_recorder_idx on app.lost_found_claims (recorded_by_membership_id);
create index lost_found_claims_decider_idx on app.lost_found_claims (decided_by_membership_id);
create unique index lost_found_claims_open_key on app.lost_found_claims (lost_found_item_id) where decided_at is null;
call private.install_domain_table('app.lost_found_claims', 'app.lost_found_items', 'lost_found_item_id',
  array['app.memberships', 'recorded_by_membership_id', 'app.memberships', 'decided_by_membership_id']);
call private.describe('app.lost_found_claims', 'Claim records of lost items: who claimed it, how to reach them, their proof, and whether the item was returned. One open claim per item. Claimant contact is Confidential.', array[
  'lost_found_item_id', 'Item claimed.',
  'claimant_name', 'Name of the person claiming.',
  'claimant_contact', 'Phone or email of the claimant (Confidential).',
  'proof_description', 'How the claimant described or proved the item.',
  'recorded_by_membership_id', 'Member who took the claim.',
  'decided_by_membership_id', 'Member who returned the item or rejected the claim.',
  'decided_at', 'When the claim was settled.',
  'returned', 'True when the item was handed back, false when the claim was rejected.',
  'decision_note', 'Why a claim was rejected, or a return note.'
]);
call private.install_policies('app.lost_found_claims',
  $$exists (select 1 from app.lost_found_items i where i.id = lost_found_item_id and i.project_id in (select private.project_ids_with('safety.incident.read')))$$);

insert into private.column_classifications (table_name, column_name, classification) values
  ('app.lost_found_claims', 'claimant_name', 'Confidential'),
  ('app.lost_found_claims', 'claimant_contact', 'Confidential');

create or replace function app.log_lost_item(
  p_project_id uuid,
  p_category app.lost_item_category,
  p_description text,
  p_found_location text,
  p_storage_location text default null,
  p_found_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select p.org_id from app.projects p where p.id = p_project_id and p.deleted_at is null);
  v_id uuid;
  v_number text;
begin
  perform private.require_person();
  if v_org is null or not private.can_on_project(p_project_id, 'safety.incident.write') then
    raise exception using errcode = '42501', message = 'logging lost items needs safety.incident.write on the project';
  end if;
  v_number := 'LF-' || lpad(private.next_sequence(v_org, 'lost_found_item')::text, 4, '0');
  perform private.begin_trusted_operation('log_lost_item');
  insert into app.lost_found_items (project_id, item_number, category, description, found_at, found_location, storage_location, logged_by_membership_id)
  values (p_project_id, v_number, p_category, btrim(p_description), coalesce(p_found_at, now()), btrim(p_found_location),
    nullif(btrim(p_storage_location), ''), private.my_membership_in(v_org))
  returning id into v_id;
  perform private.end_trusted_operation('log_lost_item');
  perform private.emit_event(v_org, 'lost_item.logged', 'lost_found_items', v_id, p_project_id,
    jsonb_build_object('item_number', v_number, 'category', p_category));
  return v_id;
end;
$$;
comment on function app.log_lost_item(uuid, app.lost_item_category, text, text, text, timestamptz) is 'Logs a found item on a project (safety.incident.write) with its next LF number. Photos are attached to the returned item id. Returns the item id.';
revoke all on function app.log_lost_item(uuid, app.lost_item_category, text, text, text, timestamptz) from public, anon;
grant execute on function app.log_lost_item(uuid, app.lost_item_category, text, text, text, timestamptz) to authenticated, service_role;

create or replace function app.claim_lost_item(p_item_id uuid, p_claimant_name text, p_claimant_contact text, p_proof_description text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item app.lost_found_items;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_item from app.lost_found_items i where i.id = p_item_id and i.deleted_at is null;
  if v_item.id is null or not private.can_on_project(v_item.project_id, 'safety.incident.write') then
    raise exception using errcode = '42501', message = 'recording claims needs safety.incident.write on the project';
  end if;
  if v_item.item_state <> 'Logged' then
    perform private.refuse('lost_item_not_held', format('This item is %s; only a held item takes a claim.', v_item.item_state));
  end if;
  insert into app.lost_found_claims (lost_found_item_id, claimant_name, claimant_contact, proof_description, recorded_by_membership_id)
  values (p_item_id, btrim(p_claimant_name), btrim(p_claimant_contact), btrim(p_proof_description), private.my_membership_in(v_item.org_id))
  returning id into v_id;
  perform private.transition_lifecycle('lost_item', 'app.lost_found_items', 'item_state', 'app.lost_item_state_transitions',
    'lost_found_item_id', p_item_id, 'Logged', 'Claimed', 'Claim recorded.');
  perform private.emit_event(v_item.org_id, 'lost_item.claimed', 'lost_found_claims', v_id, v_item.project_id,
    jsonb_build_object('item_number', v_item.item_number));
  return v_id;
end;
$$;
comment on function app.claim_lost_item(uuid, text, text, text) is 'Records a claim on a held item (safety.incident.write) with the claimant''s name, contact and proof; the item waits as Claimed until the claim is settled. Returns the claim id.';
revoke all on function app.claim_lost_item(uuid, text, text, text) from public, anon;
grant execute on function app.claim_lost_item(uuid, text, text, text) to authenticated, service_role;

create or replace function app.settle_lost_item_claim(p_claim_id uuid, p_returned boolean, p_note text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim app.lost_found_claims;
  v_item app.lost_found_items;
  v_mine uuid;
begin
  perform private.require_person();
  select * into v_claim from app.lost_found_claims c where c.id = p_claim_id and c.deleted_at is null;
  select * into v_item from app.lost_found_items i where i.id = v_claim.lost_found_item_id;
  if v_claim.id is null or not private.can_on_project(v_item.project_id, 'safety.incident.close') then
    raise exception using errcode = '42501', message = 'settling claims needs safety.incident.close on the project';
  end if;
  if v_claim.decided_at is not null then
    perform private.refuse('lost_item_claim_settled', 'This claim is already settled.');
  end if;
  if not p_returned and coalesce(btrim(p_note), '') = '' then
    perform private.refuse('lost_item_rejection_note', 'Say why the claim is rejected.');
  end if;
  v_mine := private.my_membership_in(v_item.org_id);
  update app.lost_found_claims set decided_at = now(), decided_by_membership_id = v_mine, returned = p_returned, decision_note = nullif(btrim(p_note), '')
  where id = p_claim_id;
  perform private.transition_lifecycle('lost_item', 'app.lost_found_items', 'item_state', 'app.lost_item_state_transitions',
    'lost_found_item_id', v_item.id, 'Claimed', case when p_returned then 'Returned' else 'Logged' end,
    coalesce(nullif(btrim(p_note), ''), 'Returned to the verified owner.'));
  if p_returned then
    perform private.emit_event(v_item.org_id, 'lost_item.returned', 'lost_found_items', v_item.id, v_item.project_id,
      jsonb_build_object('item_number', v_item.item_number, 'claim_id', p_claim_id));
  end if;
  return p_claim_id;
end;
$$;
comment on function app.settle_lost_item_claim(uuid, boolean, text) is 'Settles an open claim (safety.incident.close): returns the item to the verified claimant, or rejects the claim with a reason and holds the item again. Returns the claim id.';
revoke all on function app.settle_lost_item_claim(uuid, boolean, text) from public, anon;
grant execute on function app.settle_lost_item_claim(uuid, boolean, text) to authenticated, service_role;

create or replace function app.dispose_lost_item(p_item_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item app.lost_found_items;
begin
  perform private.require_person();
  select * into v_item from app.lost_found_items i where i.id = p_item_id and i.deleted_at is null;
  if v_item.id is null or not private.can_on_project(v_item.project_id, 'safety.incident.close') then
    raise exception using errcode = '42501', message = 'disposing items needs safety.incident.close on the project';
  end if;
  return private.transition_lifecycle('lost_item', 'app.lost_found_items', 'item_state', 'app.lost_item_state_transitions',
    'lost_found_item_id', p_item_id, 'Logged', 'Disposed', p_reason);
end;
$$;
comment on function app.dispose_lost_item(uuid, text) is 'Disposes of an unclaimed held item with a reason (safety.incident.close). Returns the ledger entry id.';
revoke all on function app.dispose_lost_item(uuid, text) from public, anon;
grant execute on function app.dispose_lost_item(uuid, text) to authenticated, service_role;

call private.install_default_retention('app.occupancy_counters');
call private.install_default_retention('app.occupancy_counts', interval '2 years');
call private.install_default_retention('app.weather_thresholds');
call private.install_default_retention('app.weather_alert_roles');
call private.install_default_retention('app.weather_readings', interval '2 years');
call private.install_default_retention('app.weather_alerts');
call private.install_default_retention('app.guest_check_ins', interval '2 years');
call private.install_default_retention('app.lost_found_items', interval '2 years');
call private.install_default_retention('app.lost_item_state_transitions', interval '2 years');
call private.install_default_retention('app.lost_found_claims', interval '2 years');
