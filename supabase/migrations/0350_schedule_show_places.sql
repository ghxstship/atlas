-- 0350_schedule_show_places.sql
-- A03 Domain Data. Schedule (baselines, actuals, calendars), Show (run of show, cues, day sheets,
-- call sheets) and Places (spaces, zones, capability documents with a frozen flag and validity
-- window, site plans and pins, postgis geofences) from Section 7.4. Two installers keep the remaining
-- domains uniform: project tables follow invariant 2 through project_ids_with, and child tables
-- follow their parent's project.

-- Installers ----------------------------------------------------------------------------------------------

create or replace procedure private.install_project_table(p_table regclass, p_read_capability text, p_write_capability text, p_references text[] default '{}')
language plpgsql
set search_path = ''
as $$
begin
  call private.install_domain_table(p_table, 'app.projects', 'project_id', p_references);
  call private.install_policies(p_table,
    format('project_id in (select private.project_ids_with(%L))', p_read_capability),
    format('project_id in (select private.project_ids_with(%L))', p_write_capability));
end;
$$;

comment on procedure private.install_project_table(regclass, text, text, text[]) is 'Makes a table with a project_id a tenant table whose rows are read and written under invariant 2 with the named capabilities.';
revoke all on procedure private.install_project_table(regclass, text, text, text[]) from public, anon, authenticated;

create or replace procedure private.install_child_table(
  p_table regclass, p_parent text, p_parent_column text, p_read_capability text, p_write_capability text, p_references text[] default '{}')
language plpgsql
set search_path = ''
as $$
begin
  call private.install_domain_table(p_table, p_parent, p_parent_column, p_references);
  call private.install_policies(p_table,
    format('%I in (select x.id from %s x where x.project_id in (select private.project_ids_with(%L)))', p_parent_column, p_parent, p_read_capability),
    format('%I in (select x.id from %s x where x.project_id in (select private.project_ids_with(%L)))', p_parent_column, p_parent, p_write_capability));
end;
$$;

comment on procedure private.install_child_table(regclass, text, text, text, text, text[]) is 'Makes a child table of a project table a tenant table whose rows follow the parent''s project under invariant 2.';
revoke all on procedure private.install_child_table(regclass, text, text, text, text, text[]) from public, anon, authenticated;

create or replace function private.assert_same_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_project uuid := (v_row ->> 'project_id')::uuid;
  v_other uuid;
  i integer := 0;
begin
  while i < tg_nargs loop
    if (v_row ->> tg_argv[i + 1]) is not null then
      execute format('select project_id from %s where id = $1', tg_argv[i]) into v_other using (v_row ->> tg_argv[i + 1])::uuid;
      if v_other is distinct from v_project then
        perform private.refuse('same_project', format('%s.%s points to a row of another project.', tg_table_name, tg_argv[i + 1]));
      end if;
    end if;
    i := i + 2;
  end loop;
  return new;
end;
$$;

comment on function private.assert_same_project() is 'Before insert or update trigger: refuses references into another project. Arguments are pairs of referenced table and referencing column.';
revoke all on function private.assert_same_project() from public, anon, authenticated;

-- Schedule ----------------------------------------------------------------------------------------------------

create table app.calendars (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  name text not null,
  time_zone text not null,
  deleted_at timestamptz,
  constraint calendars_name_length check (char_length(btrim(name)) between 1 and 100)
);
create index calendars_project_id_idx on app.calendars (project_id);
call private.install_project_table('app.calendars', 'schedule.timeline.read', 'schedule.timeline.write');
call private.describe('app.calendars', 'Working calendars of a project that schedules count working time against.', array[
  'project_id', 'Project.', 'name', 'Calendar name.', 'time_zone', 'IANA zone the calendar''s days are read in.'
]);

create table app.calendar_exceptions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  calendar_id uuid not null references app.calendars (id),
  day date not null,
  is_working boolean not null,
  note text,
  deleted_at timestamptz
);
create unique index calendar_exceptions_day_key on app.calendar_exceptions (calendar_id, day) where deleted_at is null;
call private.install_child_table('app.calendar_exceptions', 'app.calendars', 'calendar_id', 'schedule.timeline.read', 'schedule.timeline.write');
call private.describe('app.calendar_exceptions', 'Days a calendar treats differently from its normal week, one row per day.', array[
  'calendar_id', 'Calendar.', 'day', 'Day.', 'is_working', 'True when the day is worked.', 'note', 'Why the day differs.'
]);

create table app.schedule_baselines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  name text not null,
  locked_at timestamptz,
  deleted_at timestamptz,
  constraint schedule_baselines_name_length check (char_length(btrim(name)) between 1 and 100)
);
create index schedule_baselines_project_id_idx on app.schedule_baselines (project_id);
call private.install_project_table('app.schedule_baselines', 'schedule.timeline.read', 'schedule.baseline.write');
call private.describe('app.schedule_baselines', 'Named snapshots of a project''s planned dates. Once locked a baseline never changes.', array[
  'project_id', 'Project.', 'name', 'Baseline name, such as Gate 3 Baseline.', 'locked_at', 'When the baseline was locked.'
]);

create table app.schedule_baseline_items (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  schedule_baseline_id uuid not null references app.schedule_baselines (id),
  record_id uuid not null references app.records (id),
  planned_starts_at timestamptz,
  planned_ends_at timestamptz,
  constraint schedule_baseline_items_window check (planned_ends_at is null or planned_starts_at is null or planned_ends_at >= planned_starts_at)
);
create index schedule_baseline_items_baseline_idx on app.schedule_baseline_items (schedule_baseline_id);
create index schedule_baseline_items_record_id_idx on app.schedule_baseline_items (record_id);
create unique index schedule_baseline_items_record_key on app.schedule_baseline_items (schedule_baseline_id, record_id);
call private.install_child_table('app.schedule_baseline_items', 'app.schedule_baselines', 'schedule_baseline_id', 'schedule.timeline.read', 'schedule.baseline.write', array['app.records', 'record_id']);
call private.describe('app.schedule_baseline_items', 'The planned window of one record in a baseline. Variance against the record''s current dates is derived.', array[
  'schedule_baseline_id', 'Baseline.', 'record_id', 'Record of the baseline''s project.', 'planned_starts_at', 'Planned start.', 'planned_ends_at', 'Planned end.'
]);

create or replace function private.guard_baseline_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select b.locked_at from app.schedule_baselines b where b.id = coalesce(new.schedule_baseline_id, old.schedule_baseline_id)) is not null then
    perform private.refuse('baseline_locked', 'A locked baseline never changes.');
  end if;
  if tg_op <> 'DELETE' and (select r.project_id from app.records r where r.id = new.record_id)
     <> (select b.project_id from app.schedule_baselines b where b.id = new.schedule_baseline_id) then
    perform private.refuse('same_project', 'A baseline item names a record of the baseline''s project.');
  end if;
  return coalesce(new, old);
end;
$$;
comment on function private.guard_baseline_item() is 'Baseline items: records of the same project; nothing changes once the baseline is locked.';
revoke all on function private.guard_baseline_item() from public, anon, authenticated;
create trigger t40_guard_baseline_item before insert or update or delete on app.schedule_baseline_items
  for each row execute function private.guard_baseline_item();

create table app.schedule_actuals (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  record_id uuid not null references app.records (id),
  actual_starts_at timestamptz,
  actual_ends_at timestamptz,
  deleted_at timestamptz,
  constraint schedule_actuals_window check (actual_ends_at is null or actual_starts_at is null or actual_ends_at >= actual_starts_at)
);
create unique index schedule_actuals_record_key on app.schedule_actuals (record_id) where deleted_at is null;
call private.install_domain_table('app.schedule_actuals', 'app.records', 'record_id');
call private.install_policies('app.schedule_actuals',
  $$record_id in (select private.record_ids_with('schedule.timeline.read'))$$,
  $$record_id in (select private.record_ids_with('schedule.timeline.write'))$$);
call private.describe('app.schedule_actuals', 'When a record actually started and finished, one row per record.', array[
  'record_id', 'Record.', 'actual_starts_at', 'Actual start.', 'actual_ends_at', 'Actual finish.'
]);

-- Show ----------------------------------------------------------------------------------------------------------

create table app.run_of_show (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  scope_node_id uuid references app.scope_nodes (id),
  name text not null,
  show_date date not null,
  deleted_at timestamptz,
  constraint run_of_show_name_length check (char_length(btrim(name)) between 1 and 200)
);
create index run_of_show_project_id_idx on app.run_of_show (project_id, show_date);
create index run_of_show_scope_node_id_idx on app.run_of_show (scope_node_id);
call private.install_project_table('app.run_of_show', 'show.run_of_show.read', 'show.run_of_show.write', array['app.scope_nodes', 'scope_node_id']);
call private.describe('app.run_of_show', 'A show day''s running order for a scope node.', array[
  'project_id', 'Project.', 'scope_node_id', 'Show node of the same project.', 'name', 'Running order name.', 'show_date', 'Show day.'
]);
create trigger t39_run_of_show_project before insert or update on app.run_of_show
  for each row execute function private.assert_same_project('app.scope_nodes', 'scope_node_id');

create table app.cues (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  run_of_show_id uuid not null references app.run_of_show (id),
  position integer not null,
  label text not null,
  planned_at timestamptz,
  duration interval,
  called_at timestamptz,
  called_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint cues_position_positive check (position > 0),
  constraint cues_label_length check (char_length(btrim(label)) between 1 and 200),
  constraint cues_called_pair check ((called_at is null) = (called_by is null))
);
create unique index cues_position_key on app.cues (run_of_show_id, position) where deleted_at is null;
create index cues_called_by_idx on app.cues (called_by);
call private.install_child_table('app.cues', 'app.run_of_show', 'run_of_show_id', 'show.run_of_show.read', 'show.run_of_show.write');
call private.describe('app.cues', 'Cues in a running order. Calling a cue stamps who called it and when.', array[
  'run_of_show_id', 'Running order.', 'position', 'Order in the running order.', 'label', 'Cue label.',
  'planned_at', 'Planned time.', 'duration', 'Planned length.', 'called_at', 'When the cue was called.', 'called_by', 'Who called the cue.'
]);

create or replace function private.guard_cue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.called_at is not null and (tg_op = 'INSERT' or old.called_at is null) then
    new.called_at := now();
    new.called_by := private.current_person_id();
  elsif tg_op = 'UPDATE' and old.called_at is not null then
    new.called_at := old.called_at;
    new.called_by := old.called_by;
  end if;
  return new;
end;
$$;
comment on function private.guard_cue() is 'A called cue is stamped with the database time and session person, once.';
revoke all on function private.guard_cue() from public, anon, authenticated;
create trigger t40_guard_cue before insert or update on app.cues for each row execute function private.guard_cue();

create table app.day_sheets (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  day date not null,
  body text not null,
  deleted_at timestamptz
);
create unique index day_sheets_day_key on app.day_sheets (project_id, day) where deleted_at is null;
call private.install_project_table('app.day_sheets', 'show.run_of_show.read', 'show.day_sheet.write');
call private.describe('app.day_sheets', 'The day sheet of a project day: the schedule and notes everyone works from.', array[
  'project_id', 'Project.', 'day', 'Day covered.', 'body', 'Day sheet content as rich text.'
]);

create table app.call_sheets (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  day date not null,
  published_at timestamptz,
  deleted_at timestamptz
);
create unique index call_sheets_day_key on app.call_sheets (project_id, day) where deleted_at is null;
call private.install_project_table('app.call_sheets', 'show.run_of_show.read', 'show.call_sheet.publish');
call private.describe('app.call_sheets', 'The call sheet of a project day. Calls are derived from the day''s shifts.', array[
  'project_id', 'Project.', 'day', 'Day.', 'published_at', 'When the call sheet was published to crew.'
]);

-- Places --------------------------------------------------------------------------------------------------------

create table app.spaces (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  venue_id uuid not null references app.venues (id),
  urid text references xpms.dim_category (cat_urid),
  name text not null,
  area_sq_ft numeric,
  capacity integer,
  deleted_at timestamptz,
  constraint spaces_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint spaces_area_positive check (area_sq_ft is null or area_sq_ft > 0),
  constraint spaces_capacity_positive check (capacity is null or capacity > 0)
);
create index spaces_venue_id_idx on app.spaces (venue_id);
create index spaces_urid_idx on app.spaces (urid);
call private.install_domain_table('app.spaces', 'app.venues', 'venue_id');
call private.install_policies('app.spaces',
  $$venue_id in (select v.id from app.venues v where v.org_id in (select private.orgs_with_capability('places.venue.read'))
    or v.id in (select p.venue_id from app.projects p where p.id in (select private.readable_project_ids())))$$,
  $$org_id in (select private.orgs_with_capability('places.space.write'))$$);
call private.describe('app.spaces', 'Spaces of a venue, keyed to the URID of the space type. Unmeasured area or capacity stays NULL.', array[
  'venue_id', 'Venue.', 'urid', 'Category of the space.', 'name', 'Space name.', 'area_sq_ft', 'Floor area in square feet.', 'capacity', 'Occupant capacity.'
]);

create table app.zones (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  venue_id uuid not null references app.venues (id),
  space_id uuid references app.spaces (id),
  code text not null,
  name text not null,
  deleted_at timestamptz,
  constraint zones_code_format check (code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  constraint zones_name_length check (char_length(btrim(name)) between 1 and 200)
);
create index zones_venue_id_idx on app.zones (venue_id);
create index zones_space_id_idx on app.zones (space_id);
create unique index zones_code_key on app.zones (venue_id, code) where deleted_at is null;
call private.install_domain_table('app.zones', 'app.venues', 'venue_id', array['app.spaces', 'space_id']);
call private.install_policies('app.zones',
  $$venue_id in (select v.id from app.venues v where v.org_id in (select private.orgs_with_capability('places.venue.read'))
    or v.id in (select p.venue_id from app.projects p where p.id in (select private.readable_project_ids())))$$,
  $$org_id in (select private.orgs_with_capability('places.space.write'))$$);
call private.describe('app.zones', 'Access and operations zones of a venue, used by the access grid and radio plan. Listed in code order.', array[
  'venue_id', 'Venue.', 'space_id', 'Space the zone sits in, when within one.', 'code', 'Zone code, unique per venue.', 'name', 'Zone name.'
]);

create table app.capability_documents (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  venue_id uuid not null references app.venues (id),
  title text not null,
  document_uri text not null,
  valid_from date not null,
  valid_to date,
  is_frozen boolean not null default false,
  deleted_at timestamptz,
  constraint capability_documents_validity check (valid_to is null or valid_to >= valid_from)
);
create index capability_documents_venue_id_idx on app.capability_documents (venue_id);
call private.install_domain_table('app.capability_documents', 'app.venues', 'venue_id');
call private.install_policies('app.capability_documents',
  $$venue_id in (select v.id from app.venues v where v.org_id in (select private.orgs_with_capability('places.venue.read'))
    or v.id in (select p.venue_id from app.projects p where p.id in (select private.readable_project_ids())))$$,
  $$org_id in (select private.orgs_with_capability('places.capability_document.write'))$$);
call private.describe('app.capability_documents', 'Venue capability documents (tech packs, rigging plots) with a validity window. A frozen document never changes; a stale one fails G3.NO_STALE_DOCS.', array[
  'venue_id', 'Venue.', 'title', 'Document title.', 'document_uri', 'Where the document is stored.',
  'valid_from', 'First day the document is valid.', 'valid_to', 'Last day it is valid; after it the document is stale.', 'is_frozen', 'True once frozen (G1.CAPABILITY_FROZEN); frozen documents never change.'
]);

create or replace function private.guard_capability_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_frozen and (new.title <> old.title or new.document_uri <> old.document_uri or new.valid_from <> old.valid_from
     or new.valid_to is distinct from old.valid_to or not new.is_frozen or new.venue_id <> old.venue_id) then
    perform private.refuse('capability_document_frozen', 'A frozen capability document never changes; add a new version.');
  end if;
  return new;
end;
$$;
comment on function private.guard_capability_document() is 'Frozen capability documents never change and never unfreeze.';
revoke all on function private.guard_capability_document() from public, anon, authenticated;
create trigger t40_guard_capability_document before update on app.capability_documents
  for each row execute function private.guard_capability_document();

create table app.site_plans (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  venue_id uuid references app.venues (id),
  title text not null,
  image_uri text not null,
  deleted_at timestamptz
);
create index site_plans_project_id_idx on app.site_plans (project_id);
create index site_plans_venue_id_idx on app.site_plans (venue_id);
call private.install_project_table('app.site_plans', 'places.venue.read', 'places.site_plan.write', array['app.venues', 'venue_id']);
call private.describe('app.site_plans', 'Site plans of a project: a drawing that pins are placed on.', array[
  'project_id', 'Project.', 'venue_id', 'Venue drawn.', 'title', 'Plan title.', 'image_uri', 'Where the drawing is stored.'
]);

create table app.site_plan_pins (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  site_plan_id uuid not null references app.site_plans (id),
  label text not null,
  x_ratio numeric not null,
  y_ratio numeric not null,
  record_id uuid references app.records (id),
  zone_id uuid references app.zones (id),
  deleted_at timestamptz,
  constraint site_plan_pins_position check (x_ratio between 0 and 1 and y_ratio between 0 and 1)
);
create index site_plan_pins_site_plan_id_idx on app.site_plan_pins (site_plan_id);
create index site_plan_pins_record_id_idx on app.site_plan_pins (record_id);
create index site_plan_pins_zone_id_idx on app.site_plan_pins (zone_id);
call private.install_child_table('app.site_plan_pins', 'app.site_plans', 'site_plan_id', 'places.venue.read', 'places.site_plan.write',
  array['app.records', 'record_id', 'app.zones', 'zone_id']);
call private.describe('app.site_plan_pins', 'Pins on a site plan, positioned as fractions of the drawing''s width and height.', array[
  'site_plan_id', 'Site plan.', 'label', 'Pin label.', 'x_ratio', 'Horizontal position, 0 to 1 from the left.', 'y_ratio', 'Vertical position, 0 to 1 from the top.',
  'record_id', 'Record the pin marks, when it marks one.', 'zone_id', 'Zone the pin marks, when it marks one.'
]);

create table app.geofences (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  venue_id uuid not null references app.venues (id),
  zone_id uuid references app.zones (id),
  name text not null,
  boundary extensions.geography(polygon, 4326) not null,
  deleted_at timestamptz,
  constraint geofences_name_length check (char_length(btrim(name)) between 1 and 200)
);
create index geofences_venue_id_idx on app.geofences (venue_id);
create index geofences_zone_id_idx on app.geofences (zone_id);
create index geofences_boundary_idx on app.geofences using gist (boundary);
call private.install_domain_table('app.geofences', 'app.venues', 'venue_id', array['app.zones', 'zone_id']);
call private.install_policies('app.geofences',
  $$venue_id in (select v.id from app.venues v where v.org_id in (select private.orgs_with_capability('places.venue.read'))
    or v.id in (select p.venue_id from app.projects p where p.id in (select private.readable_project_ids())))$$,
  $$org_id in (select private.orgs_with_capability('places.space.write'))$$);
call private.describe('app.geofences', 'Geofences of a venue as WGS 84 polygons (postgis), used to check that punches and scans happen on site.', array[
  'venue_id', 'Venue.', 'zone_id', 'Zone the geofence outlines, when it outlines one.', 'name', 'Geofence name.', 'boundary', 'Polygon boundary in WGS 84.'
]);

create or replace function app.point_in_geofence(p_geofence_id uuid, p_longitude double precision, p_latitude double precision)
returns boolean
language sql
stable
set search_path = ''
as $$
  select extensions.st_covers(g.boundary, extensions.st_setsrid(extensions.st_makepoint(p_longitude, p_latitude), 4326)::extensions.geography)
  from app.geofences g where g.id = p_geofence_id;
$$;
comment on function app.point_in_geofence(uuid, double precision, double precision) is 'True when a WGS 84 point lies inside a geofence the caller can read; NULL when the geofence is not visible.';
revoke all on function app.point_in_geofence(uuid, double precision, double precision) from public, anon;
grant execute on function app.point_in_geofence(uuid, double precision, double precision) to authenticated, service_role;
