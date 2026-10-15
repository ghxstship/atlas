-- 0420_places_safety.sql
-- A09 Places, requirements and capability reconciliation, and Safety (permit engine, inspections).
-- Range 0420 to 0429 (ADR 0022). This migration:
--   * adds the venue location (ADR 0019 open item, settled by the orchestrator): a nullable WGS 84
--     point; NULL means the venue is not located, so no map pin and no guessed coordinate
--   * declares the domain events of Places, the permit engine, inspections and reconciliation, and
--     attaches their emit triggers; A18's triggers on app.domain_events carry each one into the audit
--     ledger (Section 7.5 invariant 23), the activity feed and webhooks
--   * adds project_id to inspection results, maintained from the inspection, for Compass sync
--   * app.reconcile_project: one transaction that reconciles a project's requirements against its
--     capabilities with the silence rule (Section 3.7): no claim is Unknown, never Met
--   * app.track_permit_requirement: opens the Permit record that tracks a generated requirement, in
--     one transaction with its record_permit row and the link back
--   * create or replace of app.generate_permit_requirements so element-triggered canon rules are
--     filtered through xpms.bridge_element_permit against the project's selected elements, without
--     ever dropping a rule canon is silent about

-- Venue location --------------------------------------------------------------------------------------------

alter table app.venues add column location extensions.geography(point, 4326);
create index venues_location_idx on app.venues using gist (location);
comment on column app.venues.location is 'Venue location as a WGS 84 point (postgis). NULL when the venue has not been located; a map shows only located venues and never guesses a position.';

create or replace function app.venue_longitude(p_venue app.venues)
returns double precision
language sql
stable
set search_path = ''
as $$
  select extensions.st_x(p_venue.location::extensions.geometry);
$$;
comment on function app.venue_longitude(app.venues) is 'Computed field: longitude of the venue location in degrees, or NULL when the venue is not located. Read from the one location column, never stored twice.';

create or replace function app.venue_latitude(p_venue app.venues)
returns double precision
language sql
stable
set search_path = ''
as $$
  select extensions.st_y(p_venue.location::extensions.geometry);
$$;
comment on function app.venue_latitude(app.venues) is 'Computed field: latitude of the venue location in degrees, or NULL when the venue is not located.';

revoke all on function app.venue_longitude(app.venues), app.venue_latitude(app.venues) from public, anon;
grant execute on function app.venue_longitude(app.venues), app.venue_latitude(app.venues) to authenticated, service_role;

create or replace function app.set_venue_location(p_venue_id uuid, p_longitude double precision, p_latitude double precision)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select v.org_id from app.venues v where v.id = p_venue_id);
begin
  perform private.require_person();
  if v_org is null or v_org not in (select private.orgs_with_capability('places.venue.write')) then
    raise exception using errcode = '42501', message = 'places.venue.write is required on the venue';
  end if;
  if (p_longitude is null) <> (p_latitude is null) then
    perform private.refuse('venue_location_pair', 'A venue location needs both a longitude and a latitude, or neither.');
  end if;
  if p_longitude is not null and (p_longitude not between -180 and 180 or p_latitude not between -90 and 90) then
    perform private.refuse('venue_location_range', 'Longitude runs from -180 to 180 and latitude from -90 to 90.');
  end if;
  update app.venues
  set location = case when p_longitude is null then null
                      else extensions.st_setsrid(extensions.st_makepoint(p_longitude, p_latitude), 4326)::extensions.geography end
  where id = p_venue_id;
  return p_venue_id;
end;
$$;
comment on function app.set_venue_location(uuid, double precision, double precision) is 'Sets or clears a venue location from degrees. Needs places.venue.write in the venue''s org; both coordinates or neither, each in range.';
revoke all on function app.set_venue_location(uuid, double precision, double precision) from public, anon;
grant execute on function app.set_venue_location(uuid, double precision, double precision) to authenticated, service_role;

-- Inspection results carry their project (Compass sync) ----------------------------------------------------------

alter table app.inspection_results add column project_id uuid references app.projects (id);
update app.inspection_results r set project_id = i.project_id from app.inspections i where i.id = r.inspection_id;
alter table app.inspection_results alter column project_id set not null;
create index inspection_results_project_id_idx on app.inspection_results (project_id);
comment on column app.inspection_results.project_id is 'Project of the inspection, maintained by the database from the inspection so Compass sync can scope results by project. Never accepted from the caller.';

create or replace function private.derive_inspection_result_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.project_id := (select i.project_id from app.inspections i where i.id = new.inspection_id);
  return new;
end;
$$;
comment on function private.derive_inspection_result_project() is 'Before insert or update trigger: copies the inspection''s project onto an inspection result, overriding any value sent.';
revoke all on function private.derive_inspection_result_project() from public, anon, authenticated;
create trigger t30_derive_inspection_result_project before insert or update on app.inspection_results
  for each row execute function private.derive_inspection_result_project();

-- Domain events ------------------------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('venue.created', 'venues', 'A venue was added.'),
  ('venue.updated', 'venues', 'A venue''s name, jurisdiction, time zone, address or location changed.'),
  ('venue.archived', 'venues', 'A venue was archived.'),
  ('venue.restored', 'venues', 'An archived venue was restored.'),
  ('space.created', 'spaces', 'A space was added to a venue.'),
  ('space.updated', 'spaces', 'A space''s name, type, area or capacity changed.'),
  ('space.archived', 'spaces', 'A space was archived.'),
  ('zone.created', 'zones', 'A zone was added to a venue.'),
  ('zone.updated', 'zones', 'A zone''s code, name or space changed.'),
  ('zone.archived', 'zones', 'A zone was archived.'),
  ('capability_document.created', 'capability_documents', 'A venue capability document was added.'),
  ('capability_document.updated', 'capability_documents', 'A capability document''s title, location or validity changed.'),
  ('capability_document.frozen', 'capability_documents', 'A capability document was frozen and can no longer change.'),
  ('capability_document.archived', 'capability_documents', 'A capability document was archived.'),
  ('site_plan.created', 'site_plans', 'A site plan was added to a project.'),
  ('site_plan.updated', 'site_plans', 'A site plan''s title, drawing or venue changed.'),
  ('site_plan.archived', 'site_plans', 'A site plan was archived.'),
  ('site_plan_pin.placed', 'site_plan_pins', 'A pin was placed on a site plan.'),
  ('site_plan_pin.moved', 'site_plan_pins', 'A pin moved on its site plan.'),
  ('permit_requirement.generated', 'permit_requirements', 'The permit engine added a permit requirement to a project from a canon permit rule.'),
  ('permit_requirement.tracked', 'permit_requirements', 'A Permit record began tracking a permit requirement.'),
  ('inspection_template.created', 'inspection_templates', 'An inspection template was added.'),
  ('inspection_template.updated', 'inspection_templates', 'An inspection template was renamed.'),
  ('inspection_template.archived', 'inspection_templates', 'An inspection template was archived.'),
  ('inspection.created', 'inspections', 'An inspection was started on a project.'),
  ('inspection.signed_off', 'inspections', 'An inspection was signed off; its results are frozen.'),
  ('inspection_result.recorded', 'inspection_results', 'A result was recorded against an inspection item.'),
  ('reconciliation.completed', 'reconciliations', 'A project''s requirements were reconciled against its capabilities.');

create trigger t90_emit_venue_created after insert on app.venues
  for each row execute function private.emit_row_event('venue.created', '-', 'name', 'jurisdiction_id', 'time_zone');
create trigger t90_emit_venue_updated after update on app.venues
  for each row when (old.deleted_at is not distinct from new.deleted_at and (
    old.name, old.jurisdiction_id, old.time_zone, old.street_address, old.locality, old.postal_code)
    is distinct from (new.name, new.jurisdiction_id, new.time_zone, new.street_address, new.locality, new.postal_code)
    or not extensions.st_equals(coalesce(old.location, 'POINT EMPTY'::extensions.geography)::extensions.geometry,
                                coalesce(new.location, 'POINT EMPTY'::extensions.geography)::extensions.geometry))
  execute function private.emit_row_event('venue.updated', '-', 'name', 'jurisdiction_id', 'time_zone');
create trigger t90_emit_venue_archived after update on app.venues
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_row_event('venue.archived', '-', 'name');
create trigger t90_emit_venue_restored after update on app.venues
  for each row when (old.deleted_at is not null and new.deleted_at is null)
  execute function private.emit_row_event('venue.restored', '-', 'name');

create trigger t90_emit_space_created after insert on app.spaces
  for each row execute function private.emit_row_event('space.created', '-', 'venue_id', 'name', 'urid');
create trigger t90_emit_space_updated after update on app.spaces
  for each row when (old.deleted_at is not distinct from new.deleted_at
    and (old.name, old.urid, old.area_sq_ft, old.capacity) is distinct from (new.name, new.urid, new.area_sq_ft, new.capacity))
  execute function private.emit_row_event('space.updated', '-', 'venue_id', 'name', 'urid');
create trigger t90_emit_space_archived after update on app.spaces
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_row_event('space.archived', '-', 'venue_id', 'name');

create trigger t90_emit_zone_created after insert on app.zones
  for each row execute function private.emit_row_event('zone.created', '-', 'venue_id', 'code', 'name');
create trigger t90_emit_zone_updated after update on app.zones
  for each row when (old.deleted_at is not distinct from new.deleted_at
    and (old.code, old.name, old.space_id) is distinct from (new.code, new.name, new.space_id))
  execute function private.emit_row_event('zone.updated', '-', 'venue_id', 'code', 'name');
create trigger t90_emit_zone_archived after update on app.zones
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_row_event('zone.archived', '-', 'venue_id', 'code');

create trigger t90_emit_capability_document_created after insert on app.capability_documents
  for each row execute function private.emit_row_event('capability_document.created', '-', 'venue_id', 'title', 'valid_from', 'valid_to');
create trigger t90_emit_capability_document_updated after update on app.capability_documents
  for each row when (old.deleted_at is not distinct from new.deleted_at and old.is_frozen = new.is_frozen
    and (old.title, old.document_uri, old.valid_from, old.valid_to) is distinct from (new.title, new.document_uri, new.valid_from, new.valid_to))
  execute function private.emit_row_event('capability_document.updated', '-', 'venue_id', 'title', 'valid_from', 'valid_to');
create trigger t90_emit_capability_document_frozen after update on app.capability_documents
  for each row when (not old.is_frozen and new.is_frozen)
  execute function private.emit_row_event('capability_document.frozen', '-', 'venue_id', 'title', 'valid_from', 'valid_to');
create trigger t90_emit_capability_document_archived after update on app.capability_documents
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_row_event('capability_document.archived', '-', 'venue_id', 'title');

create trigger t90_emit_site_plan_created after insert on app.site_plans
  for each row execute function private.emit_row_event('site_plan.created', 'project_id', 'venue_id', 'title');
create trigger t90_emit_site_plan_updated after update on app.site_plans
  for each row when (old.deleted_at is not distinct from new.deleted_at
    and (old.title, old.image_uri, old.venue_id) is distinct from (new.title, new.image_uri, new.venue_id))
  execute function private.emit_row_event('site_plan.updated', 'project_id', 'venue_id', 'title');
create trigger t90_emit_site_plan_archived after update on app.site_plans
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_row_event('site_plan.archived', 'project_id', 'title');

create trigger t90_emit_site_plan_pin_placed after insert on app.site_plan_pins
  for each row execute function private.emit_row_event('site_plan_pin.placed', '-', 'site_plan_id', 'label', 'x_ratio', 'y_ratio');
create trigger t90_emit_site_plan_pin_moved after update on app.site_plan_pins
  for each row when ((old.x_ratio, old.y_ratio) is distinct from (new.x_ratio, new.y_ratio))
  execute function private.emit_row_event('site_plan_pin.moved', '-', 'site_plan_id', 'label', 'x_ratio', 'y_ratio');

create trigger t90_emit_permit_requirement_generated after insert on app.permit_requirements
  for each row execute function private.emit_row_event('permit_requirement.generated', 'project_id', 'permit_rule');
create trigger t90_emit_permit_requirement_tracked after update on app.permit_requirements
  for each row when (old.record_id is null and new.record_id is not null)
  execute function private.emit_row_event('permit_requirement.tracked', 'project_id', 'permit_rule', 'record_id');

create trigger t90_emit_inspection_template_created after insert on app.inspection_templates
  for each row execute function private.emit_row_event('inspection_template.created', '-', 'name');
create trigger t90_emit_inspection_template_updated after update on app.inspection_templates
  for each row when (old.deleted_at is not distinct from new.deleted_at and old.name <> new.name)
  execute function private.emit_row_event('inspection_template.updated', '-', 'name');
create trigger t90_emit_inspection_template_archived after update on app.inspection_templates
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_row_event('inspection_template.archived', '-', 'name');

create trigger t90_emit_inspection_created after insert on app.inspections
  for each row execute function private.emit_row_event('inspection.created', 'project_id', 'inspection_template_id', 'inspector_person_id', 'inspected_at');
create trigger t90_emit_inspection_signed_off after update on app.inspections
  for each row when (old.signed_off_at is null and new.signed_off_at is not null)
  execute function private.emit_row_event('inspection.signed_off', 'project_id', 'inspection_template_id', 'signed_off_by', 'signed_off_at');

create trigger t90_emit_inspection_result_recorded after insert or update on app.inspection_results
  for each row execute function private.emit_row_event('inspection_result.recorded', '-', 'inspection_id', 'inspection_item_id', 'result_enum_id');

create trigger t90_emit_reconciliation_completed after insert on app.reconciliations
  for each row execute function private.emit_row_event('reconciliation.completed', 'project_id', 'reconciled_at');

-- Reconciliation (Section 7.4, Section 3.7) ----------------------------------------------------------------------

create or replace function private.reconciliation_result(
  p_required_quantity numeric,
  p_provided_quantity numeric,
  p_assertion_rank integer
)
returns app.reconciliation_result
language sql
immutable
set search_path = ''
as $$
  select case
    when p_assertion_rank is null or p_assertion_rank = 0 then 'Unknown'::app.reconciliation_result
    when p_required_quantity is null then 'Met'::app.reconciliation_result
    when p_provided_quantity is null then 'Unknown'::app.reconciliation_result
    when p_provided_quantity >= p_required_quantity then 'Met'::app.reconciliation_result
    else 'Gap'::app.reconciliation_result
  end;
$$;
comment on function private.reconciliation_result(numeric, numeric, integer) is 'The silence rule for one requirement against one capability (Section 3.7): no capability or an assertion of rank 0 (UNKNOWN) is Unknown; a known capability with no stated quantity meets a requirement that states none and is Unknown against one that does; otherwise Met when the provided quantity covers the requirement and Gap when it falls short. The assertion rank is passed in, read from canon by the caller.';
revoke all on function private.reconciliation_result(numeric, numeric, integer) from public, anon, authenticated;

create or replace function app.reconcile_project(p_project_id uuid, p_note text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reconciliation uuid;
begin
  perform private.require_person();
  if not exists (select 1 from app.projects p where p.id = p_project_id and p.deleted_at is null)
     or not private.can_on_project(p_project_id, 'advancing.reconciliation.write') then
    raise exception using errcode = '42501', message = 'advancing.reconciliation.write is required on the project';
  end if;
  insert into app.reconciliations (org_id, project_id, note)
  values ((select p.org_id from app.projects p where p.id = p_project_id), p_project_id, nullif(btrim(p_note), ''))
  returning id into v_reconciliation;

  -- For each requirement, the best capability on the same URID: the one with the best result, then the
  -- highest canon assertion rank, then the largest quantity. With no capability the result is Unknown.
  insert into app.reconciliation_lines (org_id, reconciliation_id, requirement_id, capability_id, result)
  select q.org_id, v_reconciliation, q.id,
         case when best.result = 'Unknown' and best.rank = 0 then null else best.capability_id end,
         coalesce(best.result, 'Unknown')
  from app.capability_statements q
  left join lateral (
    select c.id as capability_id, w.rank,
           private.reconciliation_result(q.quantity, c.quantity, w.rank) as result
    from app.capability_statements c
    join xpms.dim_assertion_word w on w.domain = c.assertion_domain and w.word = c.assertion_word
    where c.project_id = q.project_id and c.direction = 'Provide' and c.urid = q.urid and c.deleted_at is null
    order by case private.reconciliation_result(q.quantity, c.quantity, w.rank) when 'Met' then 0 when 'Gap' then 1 else 2 end,
             w.rank desc, c.quantity desc nulls last, c.id
    limit 1
  ) best on true
  where q.project_id = p_project_id and q.direction = 'Require' and q.deleted_at is null;

  -- A Met line must name its capability; a Gap names the short capability; Unknown names one only when
  -- a claim exists, so silence never points at a capability.
  return v_reconciliation;
end;
$$;
comment on function app.reconcile_project(uuid, text) is 'Reconciles every live requirement of a project against the capabilities of the same URID in one transaction and returns the reconciliation id. Silence is Unknown, never Met (Section 3.7); an Unknown against a critical requirement surfaces in app.reconciliation_gaps for G3.NO_CRITICAL_GAPS. Needs advancing.reconciliation.write on the project.';
revoke all on function app.reconcile_project(uuid, text) from public, anon;
grant execute on function app.reconcile_project(uuid, text) to authenticated, service_role;

-- Permit tracking ----------------------------------------------------------------------------------------------------

create or replace function app.track_permit_requirement(p_requirement_id uuid, p_title text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_requirement app.permit_requirements;
  v_record uuid;
begin
  perform private.require_person();
  select * into v_requirement from app.permit_requirements r where r.id = p_requirement_id and r.deleted_at is null;
  if v_requirement.id is null
     or not private.can_on_project(v_requirement.project_id, 'safety.permit.write')
     or not private.can_on_project(v_requirement.project_id, 'work.record.write') then
    raise exception using errcode = '42501', message = 'safety.permit.write and work.record.write are required on the project';
  end if;
  if v_requirement.record_id is not null then
    perform private.refuse('permit_requirement_tracked', 'This permit requirement already has a Permit record tracking it.');
  end if;
  -- Permitting is a Process (Y) activity (Section 3.6); the tag is declared because a permit rule carries no URID.
  insert into app.records (org_id, project_id, record_kind, title, xyz, xyz_basis)
  values (v_requirement.org_id, v_requirement.project_id, 'Permit',
          coalesce(nullif(btrim(p_title), ''), (select r.permit from xpms.dim_permit_rule r where r.rule = v_requirement.permit_rule)),
          'Y', 'Declared')
  returning id into v_record;
  insert into app.record_permit (record_id, org_id, permit_rule) values (v_record, v_requirement.org_id, v_requirement.permit_rule);
  update app.permit_requirements set record_id = v_record where id = p_requirement_id;
  return v_record;
end;
$$;
comment on function app.track_permit_requirement(uuid, text) is 'Opens the Permit record that tracks a permit requirement, with its record_permit row and the link back, in one transaction. The title defaults to the canon permit text and passes the Permit title grammar. Needs safety.permit.write and work.record.write on the project.';
revoke all on function app.track_permit_requirement(uuid, text) from public, anon;
grant execute on function app.track_permit_requirement(uuid, text) to authenticated, service_role;

-- Permit engine: element-triggered rules -----------------------------------------------------------------------------

create or replace function private.project_element_ids(p_project_id uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select l.element_id from app.budget_lines l join app.budgets b on b.id = l.budget_id
  where b.project_id = p_project_id and l.element_id is not null and l.deleted_at is null and b.deleted_at is null
  union
  select s.element_id from app.record_supply s join app.records r on r.id = s.record_id
  where r.project_id = p_project_id and s.element_id is not null and r.deleted_at is null and s.deleted_at is null;
$$;
comment on function private.project_element_ids(uuid) is 'The catalog elements a project has selected: elements on its live budget lines and on its Supply records. The one place the selection source is defined; the permit engine reads it.';
revoke all on function private.project_element_ids(uuid) from public, anon, authenticated;

create or replace function private.permit_rule_applies(p_project_id uuid, p_rule text, p_trigger_type text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_trigger_type <> 'element'
      or not exists (select 1 from private.project_element_ids(p_project_id))
      or not exists (select 1 from xpms.bridge_element_permit b where b.rule = p_rule)
      or exists (
        select 1 from xpms.bridge_element_permit b
        where b.rule = p_rule and b.element_id in (select private.project_element_ids(p_project_id)));
$$;
comment on function private.permit_rule_applies(uuid, text, text) is 'Whether a canon permit rule applies to a project. Project, threshold and condition rules always apply and are judged by a person against their canon condition. An element rule is dropped only when the project has selected elements (private.project_element_ids), canon bridges the rule to elements, and none of them is selected; while canon or the selection is silent the rule applies (Section 3.7: silence never passes).';
revoke all on function private.permit_rule_applies(uuid, text, text) from public, anon, authenticated;

create or replace function app.generate_permit_requirements(p_project_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project app.projects;
  v_status text;
  v_count integer;
begin
  perform private.require_person();
  if not private.can_on_project(p_project_id, 'safety.permit.write') then
    raise exception using errcode = '42501', message = 'safety.permit.write is required on the project';
  end if;
  select * into v_project from app.projects p where p.id = p_project_id;
  if v_project.jurisdiction_id is null then
    perform private.refuse('jurisdiction_no_answer', 'NO_ANSWER: the project''s jurisdiction is unresolved, so permit questions have no answer.');
  end if;
  select j.status into v_status from xpms.jurisdiction j where j.jurisdiction_id = v_project.jurisdiction_id;
  if v_status <> 'populated' then
    perform private.refuse('jurisdiction_no_answer', 'NO_ANSWER: the project''s jurisdiction is declared but unpopulated; it never passes.');
  end if;
  with recursive chain (jurisdiction_id, parent) as (
    select j.jurisdiction_id, j.parent from xpms.jurisdiction j where j.jurisdiction_id = v_project.jurisdiction_id
    union all
    select j.jurisdiction_id, j.parent from xpms.jurisdiction j join chain c on j.jurisdiction_id = c.parent
  ), inserted as (
    insert into app.permit_requirements (project_id, permit_rule)
    select p_project_id, r.rule from xpms.dim_permit_rule r
    where r.jurisdiction_id in (select c.jurisdiction_id from chain c)
      and private.permit_rule_applies(p_project_id, r.rule, r.trigger_type)
      and not exists (select 1 from app.permit_requirements e where e.project_id = p_project_id and e.permit_rule = r.rule and e.deleted_at is null)
    order by r.ordinal
    returning 1
  )
  select count(*) into v_count from inserted;
  return v_count;
end;
$$;
comment on function app.generate_permit_requirements(uuid) is 'The jurisdiction permit engine: adds every canon permit rule of the project''s jurisdiction and its parents that applies to the project (private.permit_rule_applies: element rules follow the selected elements through xpms.bridge_element_permit, and canon silence keeps a rule). An unresolved or unpopulated jurisdiction is refused with NO_ANSWER (Section 3.7), never passed. Returns the number of requirements added.';
revoke all on function app.generate_permit_requirements(uuid) from public, anon;
grant execute on function app.generate_permit_requirements(uuid) to authenticated, service_role;
