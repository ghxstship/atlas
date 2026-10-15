-- 0471_incident_field_rpcs.sql
-- A14 Safety incidents: the RPCs Compass (A17) queues offline and replays through
-- app.apply_sync_mutation (A03F 0364). The wrapper runs as its owner, so each RPC authorizes the
-- session person itself against the incident's project, exactly as row level security would. Each
-- takes an optional client id; a replay of an id the same person already stored returns that row.
-- The allowlist (private.sync_rpcs) gains these RPCs plus record_scan and transition_incident.

create or replace function app.report_incident(
  p_project_id uuid,
  p_title text,
  p_severity_enum_id text,
  p_occurred_at timestamptz,
  p_zone_id uuid default null,
  p_latitude numeric default null,
  p_longitude numeric default null,
  p_accuracy_m numeric default null,
  p_device_reported_at timestamptz default null,
  p_id uuid default null
)
returns table (id uuid, incident_number bigint, incident_state app.incident_state, replayed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_row app.incidents;
begin
  if not private.can_on_project(p_project_id, 'safety.incident.write') then
    raise exception using errcode = '42501', message = 'safety.incident.write is required on the project';
  end if;
  if p_id is not null then
    select * into v_row from app.incidents i where i.id = p_id;
    if v_row.id is not null then
      if v_row.reported_by is distinct from v_person or v_row.project_id <> p_project_id then
        perform private.refuse('incident_id_taken', 'Another incident already uses this id.');
      end if;
      return query select v_row.id, v_row.incident_number, v_row.incident_state, true;
      return;
    end if;
  end if;
  insert into app.incidents (id, org_id, project_id, title, severity_enum_id, occurred_at, zone_id,
    latitude, longitude, accuracy_m, device_reported_at)
  values (coalesce(p_id, private.uuid_v7()), (select p.org_id from app.projects p where p.id = p_project_id), p_project_id,
    btrim(p_title), p_severity_enum_id, p_occurred_at, p_zone_id, p_latitude, p_longitude, p_accuracy_m, p_device_reported_at)
  returning * into v_row;
  return query select v_row.id, v_row.incident_number, v_row.incident_state, false;
end;
$$;
comment on function app.report_incident(uuid, text, text, timestamptz, uuid, numeric, numeric, numeric, timestamptz, uuid) is 'Files an incident for a person with safety.incident.write on the project, with the device''s location and report time. The reporter comes from the session. A client id makes it idempotent: the same person replaying it gets the stored incident with replayed = true.';

create or replace function private.incident_project(p_incident_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select i.project_id from app.incidents i where i.id = p_incident_id and i.deleted_at is null;
$$;
comment on function private.incident_project(uuid) is 'Project of a live incident, or NULL. Takes the id as an argument (ADR 0016 rule 14).';
revoke all on function private.incident_project(uuid) from public, anon, authenticated;

create or replace function app.add_incident_party(
  p_incident_id uuid,
  p_description text,
  p_person_id uuid default null,
  p_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_existing app.incident_parties;
  v_id uuid;
begin
  if not private.can_on_project(private.incident_project(p_incident_id), 'safety.incident.write') then
    raise exception using errcode = '42501', message = 'safety.incident.write is required on the incident''s project';
  end if;
  if p_id is not null then
    select * into v_existing from app.incident_parties x where x.id = p_id;
    if v_existing.id is not null then
      if v_existing.created_by is distinct from v_person or v_existing.incident_id <> p_incident_id then
        perform private.refuse('incident_party_id_taken', 'Another party already uses this id.');
      end if;
      return v_existing.id;
    end if;
  end if;
  insert into app.incident_parties (id, org_id, incident_id, person_id, description)
  values (coalesce(p_id, private.uuid_v7()), (select i.org_id from app.incidents i where i.id = p_incident_id),
    p_incident_id, p_person_id, btrim(p_description))
  returning incident_parties.id into v_id;
  return v_id;
end;
$$;
comment on function app.add_incident_party(uuid, text, uuid, uuid) is 'Adds a person involved in an incident (a known person or a description) for a person with safety.incident.write on its project. Idempotent on a client id.';

create or replace function app.add_incident_media(
  p_incident_id uuid,
  p_media_uri text,
  p_captured_at timestamptz default null,
  p_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_existing app.incident_media;
  v_id uuid;
begin
  if not private.can_on_project(private.incident_project(p_incident_id), 'safety.incident.write') then
    raise exception using errcode = '42501', message = 'safety.incident.write is required on the incident''s project';
  end if;
  if p_id is not null then
    select * into v_existing from app.incident_media x where x.id = p_id;
    if v_existing.id is not null then
      if v_existing.created_by is distinct from v_person or v_existing.incident_id <> p_incident_id then
        perform private.refuse('incident_media_id_taken', 'Another photo or video already uses this id.');
      end if;
      return v_existing.id;
    end if;
  end if;
  insert into app.incident_media (id, org_id, incident_id, media_uri, captured_at)
  values (coalesce(p_id, private.uuid_v7()), (select i.org_id from app.incidents i where i.id = p_incident_id),
    p_incident_id, btrim(p_media_uri), p_captured_at)
  returning incident_media.id into v_id;
  return v_id;
end;
$$;
comment on function app.add_incident_media(uuid, text, timestamptz, uuid) is 'Attaches a stored photo or video to an incident for a person with safety.incident.write on its project. Idempotent on a client id.';

create or replace function app.dispatch_responder(
  p_incident_id uuid,
  p_membership_id uuid,
  p_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_existing app.dispatch_assignments;
  v_id uuid;
begin
  if not private.can_on_project(private.incident_project(p_incident_id), 'safety.incident.dispatch') then
    raise exception using errcode = '42501', message = 'safety.incident.dispatch is required on the incident''s project';
  end if;
  if p_id is not null then
    select * into v_existing from app.dispatch_assignments x where x.id = p_id;
    if v_existing.id is not null then
      if v_existing.created_by is distinct from v_person or v_existing.incident_id <> p_incident_id then
        perform private.refuse('dispatch_id_taken', 'Another dispatch already uses this id.');
      end if;
      return v_existing.id;
    end if;
  end if;
  insert into app.dispatch_assignments (id, org_id, incident_id, membership_id)
  values (coalesce(p_id, private.uuid_v7()), (select i.org_id from app.incidents i where i.id = p_incident_id),
    p_incident_id, p_membership_id)
  returning dispatch_assignments.id into v_id;
  return v_id;
end;
$$;
comment on function app.dispatch_responder(uuid, uuid, uuid) is 'Dispatches a responder (a membership of the same org) to an incident for a person with safety.incident.dispatch on its project. Idempotent on a client id.';

create or replace function app.mark_dispatch_arrived(p_dispatch_assignment_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.dispatch_assignments;
begin
  perform private.require_person();
  select * into v_row from app.dispatch_assignments d where d.id = p_dispatch_assignment_id and d.deleted_at is null for update;
  if v_row.id is null or not (
      v_row.membership_id in (select private.my_membership_ids())
      or private.can_on_project(private.incident_project(v_row.incident_id), 'safety.incident.dispatch')) then
    raise exception using errcode = '42501', message = 'only the responder or a dispatcher records an arrival';
  end if;
  if v_row.arrived_at is null then
    update app.dispatch_assignments set arrived_at = greatest(now(), v_row.dispatched_at) where id = v_row.id
    returning * into v_row;
  end if;
  return v_row.arrived_at;
end;
$$;
comment on function app.mark_dispatch_arrived(uuid) is 'Records a dispatched responder''s arrival, by the responder or a dispatcher on the incident''s project. A second call keeps the first arrival and returns it, so a replay is harmless.';

revoke all on function app.report_incident(uuid, text, text, timestamptz, uuid, numeric, numeric, numeric, timestamptz, uuid) from public, anon;
revoke all on function app.add_incident_party(uuid, text, uuid, uuid) from public, anon;
revoke all on function app.add_incident_media(uuid, text, timestamptz, uuid) from public, anon;
revoke all on function app.dispatch_responder(uuid, uuid, uuid) from public, anon;
revoke all on function app.mark_dispatch_arrived(uuid) from public, anon;
grant execute on function app.report_incident(uuid, text, text, timestamptz, uuid, numeric, numeric, numeric, timestamptz, uuid) to authenticated, service_role;
grant execute on function app.add_incident_party(uuid, text, uuid, uuid) to authenticated, service_role;
grant execute on function app.add_incident_media(uuid, text, timestamptz, uuid) to authenticated, service_role;
grant execute on function app.dispatch_responder(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function app.mark_dispatch_arrived(uuid) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.record_scan', 'A scanner checks a credential at a zone; the database decides the result.'),
  ('app.report_incident', 'A field person files an incident with its location.'),
  ('app.add_incident_party', 'A field person adds a person involved in an incident.'),
  ('app.add_incident_media', 'A field person attaches a photo or video to an incident.'),
  ('app.dispatch_responder', 'A dispatcher sends a responder to an incident.'),
  ('app.mark_dispatch_arrived', 'A responder records arriving at an incident.'),
  ('app.transition_incident', 'A dispatcher or responder dispatches or contains an incident.')
on conflict (rpc) do nothing;
