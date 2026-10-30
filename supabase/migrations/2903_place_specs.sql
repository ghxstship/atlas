-- 2903_place_specs.sql
-- B1 Places depth on image plans (RRR-225; gap G-92; ADR 0140 D8 and D9).
--
--   * app.place_specs holds the technical facts of a venue (space_id null) or of one of its spaces, as typed columns:
--     house power, dock and access, dimensions, rigging and network. A NULL is unknown and never passes (Section 3.7).
--     Network passwords are never stored. Org-specific extras are A117 custom fields; app.spaces becomes a target.
--   * app.provide_place_specs writes Provide capability statements from the known power, rigging and connectivity facts
--     for advancing reconciliation, DOCUMENTED when a live, unexpired capability document of the venue backs the spec
--     and CLAIMED otherwise. Those rows are copies taken when it runs and are managed by it alone.
--   * Permits gain read-only venue facts: a seeded map from canon permit rule to a fact group and the project's facts.
--     The permit engine (0420) is not touched, so no fact ever drops a rule.

-- Place specs ------------------------------------------------------------------------------------------------------------

create table app.place_specs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  venue_id uuid not null references app.venues (id),
  space_id uuid references app.spaces (id),
  house_power_amps integer,
  house_power_voltage integer,
  house_power_phase smallint,
  power_connections text,
  loading_dock_count integer,
  dock_height_in numeric,
  dock_door_width_in numeric,
  dock_door_height_in numeric,
  forklift_on_site boolean,
  dock_notes text,
  length_ft numeric,
  width_ft numeric,
  clear_height_ft numeric,
  floor_load_psf numeric,
  occupant_load integer,
  rigging_point_count integer,
  rigging_point_load_lb numeric,
  rigging_total_load_lb numeric,
  rigging_notes text,
  wifi_available boolean,
  internet_bandwidth_mbps numeric,
  hardline_available boolean,
  network_notes text,
  spec_document_id uuid references app.capability_documents (id),
  deleted_at timestamptz,
  constraint place_specs_power check (
    (house_power_amps is null or house_power_amps > 0)
    and (house_power_voltage is null or house_power_voltage between 1 and 1000)
    and (house_power_phase is null or house_power_phase in (1, 3))
    and (power_connections is null or char_length(btrim(power_connections)) between 1 and 300)),
  constraint place_specs_dock check (
    (loading_dock_count is null or loading_dock_count >= 0)
    and (dock_height_in is null or dock_height_in > 0)
    and (dock_door_width_in is null or dock_door_width_in > 0)
    and (dock_door_height_in is null or dock_door_height_in > 0)
    and (dock_notes is null or char_length(btrim(dock_notes)) between 1 and 500)),
  constraint place_specs_dimensions check (
    (length_ft is null or length_ft > 0) and (width_ft is null or width_ft > 0)
    and (clear_height_ft is null or clear_height_ft > 0) and (floor_load_psf is null or floor_load_psf > 0)
    and (occupant_load is null or occupant_load > 0)),
  constraint place_specs_occupant_load_venue check (space_id is null or occupant_load is null),
  constraint place_specs_rigging check (
    (rigging_point_count is null or rigging_point_count >= 0)
    and (rigging_point_load_lb is null or rigging_point_load_lb > 0)
    and (rigging_total_load_lb is null or rigging_total_load_lb > 0)
    and (rigging_notes is null or char_length(btrim(rigging_notes)) between 1 and 500)),
  constraint place_specs_network check (
    (internet_bandwidth_mbps is null or internet_bandwidth_mbps > 0)
    and (network_notes is null or char_length(btrim(network_notes)) between 1 and 500))
);

create index place_specs_venue_id_idx on app.place_specs (venue_id);
create index place_specs_space_id_idx on app.place_specs (space_id);
create index place_specs_spec_document_id_idx on app.place_specs (spec_document_id);
create unique index place_specs_one_per_venue on app.place_specs (venue_id) where space_id is null and deleted_at is null;
create unique index place_specs_one_per_space on app.place_specs (space_id) where deleted_at is null;

call private.install_domain_table('app.place_specs', 'app.venues', 'venue_id',
  array['app.spaces', 'space_id', 'app.capability_documents', 'spec_document_id']);
call private.install_policies('app.place_specs',
  $$venue_id in (select v.id from app.venues v where v.org_id in (select private.orgs_with_capability('places.venue.read'))
    or v.id in (select p.venue_id from app.projects p where p.id in (select private.readable_project_ids())))$$,
  $$(space_id is null and org_id in (select private.orgs_with_capability('places.venue.write')))
    or (space_id is not null and org_id in (select private.orgs_with_capability('places.space.write')))$$);
call private.describe('app.place_specs', 'Technical specs of a venue, or of one of its spaces (G-92, ADR 0140 D8): house power, dock and access, dimensions, rigging and network, one live row per venue and per space. A NULL is unknown, never a pass (Section 3.7). Network passwords are never stored; they belong in a Restricted capability document.', array[
  'venue_id', 'Venue the spec describes, or the space''s venue for a space row (derived from the space, never accepted otherwise).',
  'space_id', 'Space the spec describes; NULL for the venue''s own spec.',
  'house_power_amps', 'House power service in amperes.',
  'house_power_voltage', 'House power voltage in volts.',
  'house_power_phase', 'House power phase: 1 or 3.',
  'power_connections', 'The connections offered, as written, for example cam-lok tie-ins at the dock.',
  'loading_dock_count', 'Number of loading docks.',
  'dock_height_in', 'Dock height above grade in inches.',
  'dock_door_width_in', 'Dock door width in inches.',
  'dock_door_height_in', 'Dock door height in inches.',
  'forklift_on_site', 'Whether a forklift is available on site.',
  'dock_notes', 'Dock and access notes, as written.',
  'length_ft', 'Length in feet.',
  'width_ft', 'Width in feet.',
  'clear_height_ft', 'Clear height to the lowest obstruction in feet.',
  'floor_load_psf', 'Floor load rating in pounds per square foot.',
  'occupant_load', 'Venue rows only: the posted occupant load. A space keeps app.spaces.capacity.',
  'rigging_point_count', 'Number of rigging points.',
  'rigging_point_load_lb', 'Working load of one rigging point in pounds.',
  'rigging_total_load_lb', 'Total rigging load the structure takes in pounds.',
  'rigging_notes', 'Rigging notes, as written.',
  'wifi_available', 'Whether Wi-Fi is offered.',
  'internet_bandwidth_mbps', 'Internet bandwidth in megabits per second.',
  'hardline_available', 'Whether wired network drops are offered.',
  'network_notes', 'Network notes, as written; never a password.',
  'spec_document_id', 'Capability document of the same venue that documents the spec; a live, unexpired one makes spec-fed capabilities DOCUMENTED.'
]);
call private.install_default_retention('app.place_specs');
call private.install_audit_trail('app.place_specs');

create or replace function private.guard_place_spec()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_space_venue uuid;
  v_document_venue uuid;
begin
  if tg_op = 'UPDATE' and (new.venue_id <> old.venue_id or new.space_id is distinct from old.space_id) then
    perform private.refuse('place_spec_target', 'A spec stays on its venue or space.');
  end if;
  if new.space_id is not null then
    select s.venue_id into v_space_venue from app.spaces s where s.id = new.space_id;
    if v_space_venue is null or (new.venue_id is not null and new.venue_id <> v_space_venue) then
      perform private.refuse('place_spec_target', 'A space''s spec belongs to the space''s own venue.');
    end if;
    new.venue_id := v_space_venue;
  end if;
  if new.spec_document_id is not null then
    select d.venue_id into v_document_venue from app.capability_documents d where d.id = new.spec_document_id;
    if v_document_venue is distinct from new.venue_id then
      perform private.refuse('place_spec_document_venue', 'Choose a capability document of the same venue.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_place_spec() is 'Place specs: a space row takes its space''s venue and a row never moves (place_spec_target); the documenting capability document is one of the same venue (place_spec_document_venue).';
revoke all on function private.guard_place_spec() from public, anon, authenticated;
-- t05 runs before the tenant guards, so the org is derived from the space's venue.
create trigger t05_guard_place_spec before insert or update on app.place_specs
  for each row execute function private.guard_place_spec();

insert into private.custom_field_targets (table_name) values ('app.spaces') on conflict do nothing;

-- Advancing feed ---------------------------------------------------------------------------------------------------------

alter table app.capability_statements
  add column place_spec_id uuid references app.place_specs (id),
  add column place_spec_field text,
  add constraint capability_statements_place_spec_field check (place_spec_field in ('power', 'rigging', 'connectivity')),
  add constraint capability_statements_place_spec_pair check ((place_spec_id is null) = (place_spec_field is null)),
  add constraint capability_statements_place_spec_provides check (place_spec_id is null or direction = 'Provide');

create index capability_statements_place_spec_id_idx on app.capability_statements (place_spec_id);
create unique index capability_statements_place_spec_key on app.capability_statements (project_id, place_spec_id, place_spec_field)
  where place_spec_id is not null and deleted_at is null;

comment on column app.capability_statements.place_spec_id is 'Place spec the capability was copied from by app.provide_place_specs; such a row is managed by that function alone.';
comment on column app.capability_statements.place_spec_field is 'Which facts of the spec the row states: power, rigging or connectivity.';

create or replace function private.guard_place_spec_capability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.in_trusted_operation('place_spec_capabilities') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.place_spec_id is not null or new.place_spec_field is not null then
      perform private.refuse('place_spec_capability_managed', 'Capabilities from venue specs are written by Add venue specs as capabilities.');
    end if;
    return new;
  end if;
  if (old.place_spec_id is not null or new.place_spec_id is not null)
     and (to_jsonb(new) - array['deleted_at', 'updated_at', 'updated_by']) is distinct from (to_jsonb(old) - array['deleted_at', 'updated_at', 'updated_by']) then
    perform private.refuse('place_spec_capability_managed', 'This capability comes from the venue''s specs. Change the specs and add them again.');
  end if;
  return new;
end;
$$;

comment on function private.guard_place_spec_capability() is 'Capability statements fed from place specs are written and changed only by app.provide_place_specs (trusted operation place_spec_capabilities); a person may only move one to Trash or restore it (place_spec_capability_managed).';
revoke all on function private.guard_place_spec_capability() from public, anon, authenticated;
create trigger t45_guard_place_spec_capability before insert or update on app.capability_statements
  for each row execute function private.guard_place_spec_capability();

-- The requirement and capability views select s.*, frozen at creation (0351): recreated so they carry the new columns.
create or replace view app.project_requirements with (security_invoker = true) as
select s.* from app.capability_statements s where s.direction = 'Require' and s.deleted_at is null;
create or replace view app.project_capabilities with (security_invoker = true) as
select s.* from app.capability_statements s where s.direction = 'Provide' and s.deleted_at is null;
comment on view app.project_requirements is 'Requirements: capability statements with direction Require.';
comment on view app.project_capabilities is 'Capabilities: capability statements with direction Provide.';
do $$
declare v_col record;
begin
  for v_col in select a.attname from pg_catalog.pg_attribute a where a.attrelid = 'app.capability_statements'::regclass and a.attnum > 0 and not a.attisdropped loop
    execute format('comment on column app.project_requirements.%I is %L', v_col.attname, col_description('app.capability_statements'::regclass,
      (select attnum from pg_catalog.pg_attribute where attrelid = 'app.capability_statements'::regclass and attname = v_col.attname)));
    execute format('comment on column app.project_capabilities.%I is %L', v_col.attname, col_description('app.capability_statements'::regclass,
      (select attnum from pg_catalog.pg_attribute where attrelid = 'app.capability_statements'::regclass and attname = v_col.attname)));
  end loop;
end $$;
revoke all on app.project_requirements, app.project_capabilities from public, anon;
grant select on app.project_requirements, app.project_capabilities to authenticated, service_role;
revoke select on app.project_requirements, app.project_capabilities from xos_backup;

create or replace function private.place_spec_statement(p_spec app.place_specs, p_field text)
returns text
language sql
stable
set search_path = ''
as $$
  -- Numbers, unit symbols and the person's own text only, so the line reads the same in every language (ADR 0140 D9).
  select case when b.body is not null then
    left(concat_ws(': ', (select s.name from app.spaces s where s.id = p_spec.space_id), b.body), 500) end
  from (select nullif(case p_field
      when 'power' then concat_ws(' · ',
        p_spec.house_power_amps::text || ' A', p_spec.house_power_voltage::text || ' V', p_spec.house_power_phase::text || 'Φ',
        p_spec.power_connections)
      when 'rigging' then concat_ws(' · ',
        case when p_spec.rigging_point_count is not null and p_spec.rigging_point_load_lb is not null
               then p_spec.rigging_point_count::text || ' × ' || trim_scale(p_spec.rigging_point_load_lb)::text || ' lb'
             when p_spec.rigging_point_count is not null then p_spec.rigging_point_count::text || ' ×'
             when p_spec.rigging_point_load_lb is not null then '× ' || trim_scale(p_spec.rigging_point_load_lb)::text || ' lb' end,
        '(' || trim_scale(p_spec.rigging_total_load_lb)::text || ' lb)',
        p_spec.rigging_notes)
      else concat_ws(' · ',
        case when p_spec.wifi_available then 'Wi-Fi' end,
        trim_scale(p_spec.internet_bandwidth_mbps)::text || ' Mbps',
        case when p_spec.hardline_available then 'LAN' end,
        p_spec.network_notes)
    end, '') as body) b;
$$;

comment on function private.place_spec_statement(app.place_specs, text) is 'The description of a spec-fed capability: the space name when the spec is a space''s, then the known facts of the group as numbers and unit symbols (A, V, Φ, ×, lb, Mbps) and the person''s own notes. NULL when the group knows nothing.';
revoke all on function private.place_spec_statement(app.place_specs, text) from public, anon, authenticated;

create or replace function app.provide_place_specs(p_project_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project app.projects;
  v_spec app.place_specs;
  v_field text;
  v_description text;
  v_word text;
  v_existing uuid;
  v_written integer := 0;
begin
  perform private.require_person();
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null or not private.can_on_project(p_project_id, 'projects.scope.write') then
    raise exception using errcode = '42501', message = 'projects.scope.write is required on the project';
  end if;
  if v_project.venue_id is null then
    perform private.refuse('project_no_venue', 'Choose the project''s venue first; its specs become the capabilities.');
  end if;
  perform private.begin_trusted_operation('place_spec_capabilities');

  -- Statements whose spec is gone (deleted, or its space archived, or another venue's) leave with it.
  update app.capability_statements c set deleted_at = now()
  where c.project_id = p_project_id and c.place_spec_id is not null and c.deleted_at is null
    and not exists (
      select 1 from app.place_specs s
      left join app.spaces sp on sp.id = s.space_id
      where s.id = c.place_spec_id and s.deleted_at is null and s.venue_id = v_project.venue_id
        and (s.space_id is null or sp.deleted_at is null));

  for v_spec in
    select s.* from app.place_specs s
    left join app.spaces sp on sp.id = s.space_id
    where s.venue_id = v_project.venue_id and s.deleted_at is null and (s.space_id is null or sp.deleted_at is null)
    order by s.space_id nulls first, s.id
  loop
    v_word := case when exists (
      select 1 from app.capability_documents d
      where d.id = v_spec.spec_document_id and d.deleted_at is null
        and d.valid_from <= current_date and (d.valid_to is null or d.valid_to >= current_date))
      then 'DOCUMENTED' else 'CLAIMED' end;
    foreach v_field in array array['power', 'rigging', 'connectivity'] loop
      v_description := private.place_spec_statement(v_spec, v_field);
      select c.id into v_existing from app.capability_statements c
      where c.project_id = p_project_id and c.place_spec_id = v_spec.id and c.place_spec_field = v_field and c.deleted_at is null;
      if v_description is null then
        -- A group that is no longer known is no longer a capability.
        update app.capability_statements set deleted_at = now() where id = v_existing;
        continue;
      end if;
      if v_existing is null then
        insert into app.capability_statements (project_id, direction, urid, description, quantity, unit_basis,
          assertion_word, venue_id, place_spec_id, place_spec_field)
        values (p_project_id, 'Provide',
          case v_field when 'power' then '5000.06.01' when 'rigging' then '5000.05.02' else '9000.02.01' end,
          v_description, null, null, v_word, v_project.venue_id, v_spec.id, v_field);
      else
        update app.capability_statements
        set description = v_description, assertion_word = v_word, quantity = null, unit_basis = null,
          venue_id = v_project.venue_id, counterparty_id = null
        where id = v_existing;
      end if;
      v_written := v_written + 1;
    end loop;
  end loop;

  perform private.end_trusted_operation('place_spec_capabilities');
  return v_written;
end;
$$;

comment on function app.provide_place_specs(uuid) is 'Copies the known power (5000.06.01), rigging (5000.05.02) and connectivity (9000.02.01) facts of the project venue''s spec and its live spaces'' specs into Provide capability statements, one per spec and group, without a quantity: DOCUMENTED when a live, unexpired capability document of the venue backs the spec, CLAIMED otherwise. A re-run rewrites the same rows; a group no longer known, or a spec that is gone, is moved to Trash. Never runs on its own. Needs projects.scope.write on the project; refuses a project with no venue (project_no_venue). Returns the number of statements written.';
revoke all on function app.provide_place_specs(uuid) from public, anon;
grant execute on function app.provide_place_specs(uuid) to authenticated, service_role;

-- Permit facts -------------------------------------------------------------------------------------------------------------

create table private.permit_rule_place_facts (
  permit_rule text not null references xpms.dim_permit_rule (rule),
  fact_group text not null,
  constraint permit_rule_place_facts_pkey primary key (permit_rule, fact_group),
  constraint permit_rule_place_facts_group check (fact_group in ('occupancy', 'power', 'rigging', 'dimensions'))
);

comment on table private.permit_rule_place_facts is 'Which venue facts a person judging a canon permit rule reads (ADR 0140 D9). Display only: the permit engine never reads it, so no fact drops a rule.';
comment on column private.permit_rule_place_facts.permit_rule is 'Canon permit rule.';
comment on column private.permit_rule_place_facts.fact_group is 'Group of venue facts shown with it: occupancy, power, rigging or dimensions.';

alter table private.permit_rule_place_facts enable row level security;
revoke all on private.permit_rule_place_facts from public, anon, authenticated;
grant select on private.permit_rule_place_facts to service_role;

insert into private.permit_rule_place_facts (permit_rule, fact_group)
select v.rule, v.grp from (values
  ('Assembly occupancy', 'occupancy'), ('Crowd managers', 'occupancy'), ('Off-duty police', 'occupancy'),
  ('EMS / medical plan', 'occupancy'), ('Temporary power', 'power'), ('Crane / heavy pick', 'rigging'),
  ('Temporary stage', 'dimensions')) v (rule, grp)
where exists (select 1 from xpms.dim_permit_rule r where r.rule = v.rule)
on conflict do nothing;

-- Reference view over the private map, as app.lifecycle_transition_rules is (0300).
create view app.permit_rule_place_facts as
select f.permit_rule, f.fact_group from private.permit_rule_place_facts f;

call private.describe('app.permit_rule_place_facts', 'The venue facts shown beside each canon permit rule on the Permits page (ADR 0140 D9). Reference data; it never changes which rules apply.', array[
  'permit_rule', 'Canon permit rule.',
  'fact_group', 'occupancy, power, rigging or dimensions.'
]);
revoke all on app.permit_rule_place_facts from public, anon;
grant select on app.permit_rule_place_facts to authenticated, service_role;
revoke select on app.permit_rule_place_facts from xos_backup;

create view app.project_place_facts with (security_invoker = true) as
select p.id as project_id, p.venue_id,
  s.occupant_load, s.house_power_amps, s.house_power_voltage, s.house_power_phase,
  s.rigging_point_count, s.rigging_point_load_lb, s.rigging_total_load_lb, s.clear_height_ft,
  case when sp.spaces_count > 0 and sp.spaces_capacity_known = sp.spaces_count then sp.capacity_sum end as space_capacity_total,
  coalesce(sp.spaces_capacity_known, 0)::integer as spaces_capacity_known,
  coalesce(sp.spaces_count, 0)::integer as spaces_count,
  coalesce(d.documented, false) as documented
from app.projects p
left join app.place_specs s on s.venue_id = p.venue_id and s.space_id is null and s.deleted_at is null
left join lateral (
  select count(*) as spaces_count, count(x.capacity) as spaces_capacity_known, sum(x.capacity) as capacity_sum
  from app.spaces x where x.venue_id = p.venue_id and x.deleted_at is null
) sp on true
left join lateral (
  select true as documented from app.capability_documents c
  where c.id = s.spec_document_id and c.deleted_at is null
    and c.valid_from <= current_date and (c.valid_to is null or c.valid_to >= current_date)
) d on true
where p.deleted_at is null and p.venue_id is not null;

call private.describe('app.project_place_facts', 'The venue facts a permit reviewer reads for each project with a venue (ADR 0140 D9): the venue''s spec and its spaces'' recorded capacity. Computed, never stored; runs as the reader. A NULL is not recorded.', array[
  'project_id', 'Project.',
  'venue_id', 'The project''s venue.',
  'occupant_load', 'The venue''s posted occupant load.',
  'house_power_amps', 'House power in amperes.',
  'house_power_voltage', 'House power voltage.',
  'house_power_phase', 'House power phase.',
  'rigging_point_count', 'Number of rigging points.',
  'rigging_point_load_lb', 'Working load of one rigging point in pounds.',
  'rigging_total_load_lb', 'Total rigging load in pounds.',
  'clear_height_ft', 'Clear height in feet.',
  'space_capacity_total', 'Sum of the live spaces'' capacity, only when every live space has one recorded; otherwise NULL, so a partial sum never understates occupancy.',
  'spaces_capacity_known', 'Live spaces with a recorded capacity.',
  'spaces_count', 'Live spaces of the venue.',
  'documented', 'True when a live, unexpired capability document of the venue backs the spec.'
]);
revoke all on app.project_place_facts from public, anon;
grant select on app.project_place_facts to authenticated, service_role;
revoke select on app.project_place_facts from xos_backup;
