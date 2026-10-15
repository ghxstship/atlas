-- 0470_credentials_incidents_field.sql
-- A14 Credentials and Safety incidents (Section 4.2, Section 4.3 items 5 and 7, Section 11.13).
-- The field path Compass (A17) and Atlas share:
--   * access_scans keeps the device's own scan time and offline decision beside the server time and
--     the server's decision, so a scan made offline and uploaded later is re-decided by the database
--     and both answers stay visible;
--   * app.record_scan is the scanner's insert path: by credential id or printed number, idempotent on
--     a client id, returning the decision and who was scanned;
--   * incidents keep the reporter's location and device time;
--   * app.my_capabilities_on_project tells the apps which module controls to offer on a project;
--   * domain events and realtime for the module's tables (audit trails and retention, which come from
--     A18's 0501 and 0550, are installed in the late slot 0985).

-- Access scans: device time and offline decision ---------------------------------------------------------

alter table app.access_scans add column device_scanned_at timestamptz;
alter table app.access_scans add column offline_result app.scan_result;
comment on column app.access_scans.device_scanned_at is 'When the device scanned, from the device clock; NULL for a scan decided online. scanned_at stays the server time.';
comment on column app.access_scans.offline_result is 'What the device decided offline from its cached access grid; NULL for a scan decided online. The database result is authoritative.';

create or replace function private.guard_access_scan_device()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.device_scanned_at is not null and new.device_scanned_at > now() + interval '5 minutes' then
    perform private.refuse('scan_device_time_future', 'A scan''s device time cannot be later than the server time.');
  end if;
  if new.offline_result is not null and new.device_scanned_at is null then
    perform private.refuse('scan_offline_needs_time', 'An offline decision is recorded with the device time it was made.');
  end if;
  return new;
end;
$$;
comment on function private.guard_access_scan_device() is 'Access scans: a device time is never in the future (five minutes of clock skew allowed) and an offline decision always carries its device time.';
revoke all on function private.guard_access_scan_device() from public, anon, authenticated;
create trigger t41_guard_access_scan_device before insert on app.access_scans
  for each row execute function private.guard_access_scan_device();

-- Incidents: reporter location and device time --------------------------------------------------------------

alter table app.incidents add column latitude numeric(9, 6);
alter table app.incidents add column longitude numeric(9, 6);
alter table app.incidents add column accuracy_m numeric(8, 1);
alter table app.incidents add column device_reported_at timestamptz;
alter table app.incidents add constraint incidents_latitude_range check (latitude is null or latitude between -90 and 90);
alter table app.incidents add constraint incidents_longitude_range check (longitude is null or longitude between -180 and 180);
alter table app.incidents add constraint incidents_location_pair check ((latitude is null) = (longitude is null));
alter table app.incidents add constraint incidents_accuracy check (accuracy_m is null or (accuracy_m >= 0 and latitude is not null));
comment on column app.incidents.latitude is 'Latitude where the incident was reported (WGS 84), when the reporter''s device gave one.';
comment on column app.incidents.longitude is 'Longitude where the incident was reported (WGS 84), when the reporter''s device gave one.';
comment on column app.incidents.accuracy_m is 'Horizontal accuracy of the location in meters, as the device reported it.';
comment on column app.incidents.device_reported_at is 'When the reporter filed the report on the device; differs from created_at when the report was queued offline.';

create or replace function private.guard_incident_device()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.device_reported_at is not null and new.device_reported_at > now() + interval '5 minutes' then
    perform private.refuse('incident_device_time_future', 'An incident''s device time cannot be later than the server time.');
  end if;
  if tg_op = 'UPDATE' and new.device_reported_at is distinct from old.device_reported_at then
    perform private.refuse('incident_device_time_immutable', 'An incident keeps the device time it was reported at.');
  end if;
  return new;
end;
$$;
comment on function private.guard_incident_device() is 'Incidents: the device report time is never in the future (five minutes of clock skew allowed) and never changes.';
revoke all on function private.guard_incident_device() from public, anon, authenticated;
create trigger t41_guard_incident_device before insert or update on app.incidents
  for each row execute function private.guard_incident_device();

-- The scanner's insert path -----------------------------------------------------------------------------------

create or replace function app.record_scan(
  p_zone_id uuid,
  p_credential_id uuid default null,
  p_credential_number text default null,
  p_id uuid default null,
  p_device_scanned_at timestamptz default null,
  p_offline_result app.scan_result default null
)
returns table (
  id uuid,
  credential_id uuid,
  credential_number text,
  holder_name text,
  category_code text,
  zone_id uuid,
  zone_code text,
  scanned_at timestamptz,
  result app.scan_result,
  replayed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_zone app.zones;
  v_credential app.credentials;
  v_project uuid;
  v_scan app.access_scans;
  v_replayed boolean := false;
begin
  select * into v_zone from app.zones z where z.id = p_zone_id and z.deleted_at is null;
  if v_zone.id is null then
    raise exception using errcode = '42501', message = 'the zone does not exist or is not visible';
  end if;
  if p_credential_id is not null then
    select * into v_credential from app.credentials c where c.id = p_credential_id and c.deleted_at is null;
  elsif p_credential_number is not null then
    select * into v_credential from app.credentials c
    where c.org_id = v_zone.org_id and c.credential_number = upper(btrim(p_credential_number)) and c.deleted_at is null;
  end if;
  if v_credential.id is null or v_credential.org_id <> v_zone.org_id then
    perform private.refuse('credential_unknown', 'No credential of this organization matches the scanned code.');
  end if;
  v_project := (select cc.project_id from app.credential_categories cc where cc.id = v_credential.credential_category_id);
  if not private.can_on_project(v_project, 'credentials.scan.write') then
    raise exception using errcode = '42501', message = 'credentials.scan.write is required on the project';
  end if;

  if p_id is not null then
    select * into v_scan from app.access_scans s where s.id = p_id;
    if v_scan.id is not null then
      if v_scan.created_by is distinct from v_person or v_scan.credential_id <> v_credential.id or v_scan.zone_id <> v_zone.id then
        perform private.refuse('scan_id_taken', 'Another scan already uses this id.');
      end if;
      v_replayed := true;
    end if;
  end if;

  if not v_replayed then
    insert into app.access_scans (id, org_id, credential_id, zone_id, device_scanned_at, offline_result)
    values (coalesce(p_id, private.uuid_v7()), v_zone.org_id, v_credential.id, v_zone.id, p_device_scanned_at, p_offline_result)
    returning * into v_scan;
  end if;

  return query
  select v_scan.id, v_credential.id, v_credential.credential_number,
    (select p.full_name from app.people p where p.id = v_credential.holder_person_id),
    (select cc.code from app.credential_categories cc where cc.id = v_credential.credential_category_id),
    v_zone.id, v_zone.code, v_scan.scanned_at, v_scan.result, v_replayed;
end;
$$;
comment on function app.record_scan(uuid, uuid, text, uuid, timestamptz, app.scan_result) is 'Records a credential scan at a zone, by credential id or printed number, for a person with credentials.scan.write on the credential''s project. The database decides the result (migration 0352). A client id makes the call idempotent: replaying the same id by the same person returns the stored scan with replayed = true; another person''s id is refused.';
revoke all on function app.record_scan(uuid, uuid, text, uuid, timestamptz, app.scan_result) from public, anon;
grant execute on function app.record_scan(uuid, uuid, text, uuid, timestamptz, app.scan_result) to authenticated, service_role;

-- Module capabilities on a project, for the apps to offer the right controls ---------------------------------

create or replace function app.my_capabilities_on_project(p_project_id uuid, p_capabilities text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(c order by c), '{}')
  from unnest(p_capabilities) c
  where (c like 'credentials.%' or c like 'safety.%' or c like 'data.restricted.%')
    and private.can_on_project(p_project_id, c);
$$;
comment on function app.my_capabilities_on_project(uuid, text[]) is 'Which of the named credentials, safety and restricted-data capabilities the signed-in person may use on a project. Only shapes which controls the apps show; row level security and the RPCs still decide every write.';
revoke all on function app.my_capabilities_on_project(uuid, text[]) from public, anon;
grant execute on function app.my_capabilities_on_project(uuid, text[]) to authenticated, service_role;

-- Project copies for Compass sync ----------------------------------------------------------------------------
-- Compass syncs by project, so the rows it caches carry their project directly. Each copy is maintained by
-- the database from the parent row on insert and never accepted from the caller or changed afterwards
-- (denormalization register: project_id on incident_media, credentials, access_grid and access_scans).

create or replace function private.copy_parent_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  execute format('select project_id from %s where id = $1', tg_argv[0])
    into v_project using (to_jsonb(new) ->> tg_argv[1])::uuid;
  if tg_op = 'UPDATE' and new.project_id is distinct from old.project_id and new.project_id is distinct from v_project then
    perform private.refuse('project_copy_immutable', 'A row keeps the project of its parent.');
  end if;
  new.project_id := v_project;
  return new;
end;
$$;
comment on function private.copy_parent_project() is 'Before insert or update trigger: sets project_id from the parent row (arguments: parent table, parent id column), so the copy can never disagree with its source.';
revoke all on function private.copy_parent_project() from public, anon, authenticated;

alter table app.credentials add column project_id uuid references app.projects (id);
update app.credentials c set project_id = cc.project_id from app.credential_categories cc where cc.id = c.credential_category_id;
alter table app.credentials alter column project_id set not null;
create index credentials_project_id_idx on app.credentials (project_id);
comment on column app.credentials.project_id is 'Project of the credential''s category, copied by the database for Compass sync.';
create trigger t15_credentials_project before insert or update of credential_category_id, project_id on app.credentials
  for each row execute function private.copy_parent_project('app.credential_categories', 'credential_category_id');

alter table app.access_grid add column project_id uuid references app.projects (id);
update app.access_grid g set project_id = cc.project_id from app.credential_categories cc where cc.id = g.credential_category_id;
alter table app.access_grid alter column project_id set not null;
create index access_grid_project_id_idx on app.access_grid (project_id);
comment on column app.access_grid.project_id is 'Project of the grid row''s category, copied by the database for Compass sync.';
create trigger t15_access_grid_project before insert or update of credential_category_id, project_id on app.access_grid
  for each row execute function private.copy_parent_project('app.credential_categories', 'credential_category_id');

alter table app.access_scans add column project_id uuid references app.projects (id);
alter table app.access_scans disable trigger t95_append_only;
update app.access_scans s set project_id = c.project_id from app.credentials c where c.id = s.credential_id;
alter table app.access_scans enable trigger t95_append_only;
alter table app.access_scans alter column project_id set not null;
create index access_scans_project_id_idx on app.access_scans (project_id, scanned_at);
comment on column app.access_scans.project_id is 'Project of the scanned credential, copied by the database for Compass sync.';
create trigger t15_access_scans_project before insert on app.access_scans
  for each row execute function private.copy_parent_project('app.credentials', 'credential_id');

alter table app.incident_media add column project_id uuid references app.projects (id);
update app.incident_media m set project_id = i.project_id from app.incidents i where i.id = m.incident_id;
alter table app.incident_media alter column project_id set not null;
create index incident_media_project_id_idx on app.incident_media (project_id);
comment on column app.incident_media.project_id is 'Project of the incident, copied by the database for Compass sync.';
create trigger t15_incident_media_project before insert or update of incident_id, project_id on app.incident_media
  for each row execute function private.copy_parent_project('app.incidents', 'incident_id');

-- Domain events: dispatch, crisis all-clear and denied scans -----------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('dispatch.assigned', 'incidents', 'A responder was dispatched to an incident.'),
  ('dispatch.arrived', 'incidents', 'A dispatched responder arrived at an incident.'),
  ('crisis_alert.ended', 'crisis_alerts', 'The all-clear was given for a crisis alert.'),
  ('access_scan.denied', 'credentials', 'A credential scan at a zone was denied.')
on conflict (code) do nothing;

create trigger t90_emit_dispatch_assigned after insert on app.dispatch_assignments
  for each row execute function private.emit_subject_event('dispatch.assigned', 'incidents', 'incident_id', 'membership_id', 'dispatched_at');
create trigger t90_emit_dispatch_arrived after update on app.dispatch_assignments
  for each row when (old.arrived_at is null and new.arrived_at is not null)
  execute function private.emit_subject_event('dispatch.arrived', 'incidents', 'incident_id', 'membership_id', 'arrived_at');
create trigger t90_emit_crisis_alert_ended after update on app.crisis_alerts
  for each row when (old.ended_at is null and new.ended_at is not null)
  execute function private.emit_subject_event('crisis_alert.ended', 'crisis_alerts', 'id', 'emergency_code', 'ended_at');
create trigger t90_emit_access_scan_denied after insert on app.access_scans
  for each row when (new.result = 'Denied')
  execute function private.emit_subject_event('access_scan.denied', 'credentials', 'credential_id', 'zone_id', 'scanned_at');

-- Realtime: the dispatch board shows a new incident in under 2 s (Section 11.11). Row level security still
-- filters every change a subscriber receives.

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'app' and tablename = 'incidents') then
      alter publication supabase_realtime add table app.incidents;
    end if;
    if not exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'app' and tablename = 'dispatch_assignments') then
      alter publication supabase_realtime add table app.dispatch_assignments;
    end if;
  end if;
end;
$$;
