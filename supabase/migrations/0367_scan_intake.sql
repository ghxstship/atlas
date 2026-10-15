-- 0367_scan_intake.sql
-- A03 Domain Data (requested by A17 Compass). Scans a device could not resolve on the spot: an unknown
-- barcode, QR code or NFC tag captured offline or in Lookup mode is kept as an intake row until someone
-- resolves it to an existing record (Matched), a record created for it (Created) or dismisses it.
--   * the scanner and the device time come from the scan; the scanner is the session person
--   * the resolution, its person and time are written only by app.resolve_scan_intake, once
--   * scanners on a project write; scan log readers and the scanner read

create type app.scan_symbology as enum ('QR Code', 'Code 128', 'Code 39', 'EAN-13', 'UPC-A', 'Data Matrix', 'PDF417', 'NFC');
comment on type app.scan_symbology is 'Symbologies a Compass scanner reads.';

create type app.scan_mode as enum ('Asset', 'Credential', 'Shipment', 'Inventory', 'Lookup');
comment on type app.scan_mode is 'What the scanner was doing when it scanned: checking assets, credentials, shipments or inventory, or looking a code up.';

create type app.scan_resolution as enum ('Matched', 'Created', 'Dismissed');
comment on type app.scan_resolution is 'How an unresolved scan was settled: matched to an existing record, a record created for it, or dismissed with a note.';

create table app.scan_intake (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  scanned_value text not null,
  symbology app.scan_symbology not null,
  scan_mode app.scan_mode not null,
  scanned_by uuid references app.people (id),
  device_scanned_at timestamptz not null,
  resolved_at timestamptz,
  resolved_by uuid references app.people (id),
  resolution app.scan_resolution,
  resolved_subject_table text,
  resolved_subject_id uuid,
  resolution_note text,
  deleted_at timestamptz,
  constraint scan_intake_value_length check (char_length(scanned_value) between 1 and 2000),
  constraint scan_intake_resolution_set check ((resolved_at is null) = (resolution is null) and (resolved_at is null) = (resolved_by is null)),
  constraint scan_intake_subject_pair check ((resolved_subject_table is null) = (resolved_subject_id is null)),
  constraint scan_intake_subject_needed check (resolution is null or (resolution = 'Dismissed') = (resolved_subject_id is null)),
  constraint scan_intake_dismiss_note check (resolution is distinct from 'Dismissed' or resolution_note is not null),
  constraint scan_intake_subject_table_format check (resolved_subject_table is null or resolved_subject_table ~ '^[a-z][a-z_]*$'),
  constraint scan_intake_note_length check (resolution_note is null or char_length(btrim(resolution_note)) between 1 and 1000)
);

create index scan_intake_project_id_idx on app.scan_intake (project_id) where resolved_at is null and deleted_at is null;
create index scan_intake_project_all_idx on app.scan_intake (project_id, device_scanned_at);
create index scan_intake_scanned_by_idx on app.scan_intake (scanned_by);
create index scan_intake_resolved_by_idx on app.scan_intake (resolved_by);
create index scan_intake_value_idx on app.scan_intake (org_id, scanned_value);

call private.install_domain_table('app.scan_intake', 'app.projects', 'project_id');
call private.describe('app.scan_intake', 'Scans a device could not resolve on the spot (Section 13): kept with the device time until resolved once through app.resolve_scan_intake as Matched, Created or Dismissed.', array[
  'id', 'Primary key; a client may supply its own UUID so an offline scan is recorded once.',
  'project_id', 'Project the scan happened on.',
  'scanned_value', 'Decoded value exactly as read.',
  'symbology', 'Symbology the scanner decoded.',
  'scan_mode', 'Asset, Credential, Shipment, Inventory or Lookup.',
  'scanned_by', 'Person who scanned, set from the session.',
  'device_scanned_at', 'When the device scanned, by its clock.',
  'resolved_at', 'When the scan was resolved; NULL while open.',
  'resolved_by', 'Person who resolved it.',
  'resolution', 'Matched, Created or Dismissed.',
  'resolved_subject_table', 'Table of the record the scan resolved to, such as asset_units; NULL when dismissed.',
  'resolved_subject_id', 'Id of the record the scan resolved to; NULL when dismissed.',
  'resolution_note', 'Why the scan was resolved that way; required when dismissed.'
]);

insert into private.domain_event_types (code, subject, description) values
  ('scan_intake.recorded', 'scan_intake', 'A device recorded a scan it could not resolve.'),
  ('scan_intake.resolved', 'scan_intake', 'An unresolved scan was matched, given a new record or dismissed.');

create trigger t90_emit_scan_intake_recorded after insert on app.scan_intake
  for each row execute function private.emit_row_event('scan_intake.recorded', 'project_id', 'symbology', 'scan_mode', 'device_scanned_at');

create or replace function private.guard_scan_intake()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.scanned_by := private.current_person_id();
    end if;
    if new.resolved_at is not null or new.resolution is not null or new.resolved_subject_id is not null or new.resolution_note is not null then
      perform private.refuse('scan_intake_resolve_rpc_only', 'A scan is resolved through app.resolve_scan_intake.');
    end if;
    if new.device_scanned_at > now() + interval '5 minutes' then
      perform private.refuse('scan_intake_future', 'A scan cannot come from the future; check the device clock.');
    end if;
    return new;
  end if;
  if new.project_id <> old.project_id or new.scanned_value <> old.scanned_value or new.symbology <> old.symbology
     or new.scan_mode <> old.scan_mode or new.scanned_by is distinct from old.scanned_by or new.device_scanned_at <> old.device_scanned_at then
    perform private.refuse('scan_intake_immutable', 'A scan keeps what was scanned, how, by whom and when.');
  end if;
  if (new.resolved_at is distinct from old.resolved_at or new.resolution is distinct from old.resolution
      or new.resolved_by is distinct from old.resolved_by or new.resolved_subject_table is distinct from old.resolved_subject_table
      or new.resolved_subject_id is distinct from old.resolved_subject_id or new.resolution_note is distinct from old.resolution_note)
     and not private.in_trusted_operation('scan_intake_resolution') then
    perform private.refuse('scan_intake_resolve_rpc_only', 'A scan is resolved through app.resolve_scan_intake.');
  end if;
  return new;
end;
$$;

comment on function private.guard_scan_intake() is 'Scan intake: scanner from the session, no device time from the future, the scan itself never changes, and the resolution is written only by app.resolve_scan_intake.';
revoke all on function private.guard_scan_intake() from public, anon, authenticated;

create trigger t40_guard_scan_intake before insert or update on app.scan_intake
  for each row execute function private.guard_scan_intake();

create or replace function app.resolve_scan_intake(p_scan_intake_id uuid, p_resolution app.scan_resolution,
  p_subject_table text default null, p_subject_id uuid default null, p_note text default null)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_scan app.scan_intake;
  v_subject_org uuid;
begin
  select * into v_scan from app.scan_intake s where s.id = p_scan_intake_id and s.deleted_at is null for update;
  if v_scan.id is null or not private.can_on_project(v_scan.project_id, 'credentials.scan.write') then
    raise exception using errcode = '42501', message = 'credentials.scan.write is required on the scan''s project';
  end if;
  if v_scan.resolved_at is not null then
    perform private.refuse('scan_intake_resolved', 'This scan was already resolved.');
  end if;
  if p_resolution = 'Dismissed' and nullif(btrim(coalesce(p_note, '')), '') is null then
    perform private.refuse('scan_intake_dismiss_note', 'Say why the scan is dismissed.');
  end if;
  if p_resolution <> 'Dismissed' then
    if p_subject_table is null or p_subject_id is null or to_regclass('app.' || p_subject_table) is null
       or not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = to_regclass('app.' || p_subject_table) and a.attname = 'org_id' and not a.attisdropped) then
      perform private.refuse('scan_intake_subject', 'A matched or created scan names a tenant record it resolved to.');
    end if;
    execute format('select org_id from app.%I where id = $1', p_subject_table) into v_subject_org using p_subject_id;
    if v_subject_org is distinct from v_scan.org_id then
      perform private.refuse('scan_intake_subject', 'A matched or created scan names a tenant record it resolved to.');
    end if;
  end if;
  perform private.begin_trusted_operation('scan_intake_resolution');
  update app.scan_intake set resolved_at = now(), resolved_by = v_person, resolution = p_resolution,
    resolved_subject_table = case when p_resolution = 'Dismissed' then null else p_subject_table end,
    resolved_subject_id = case when p_resolution = 'Dismissed' then null else p_subject_id end,
    resolution_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_scan_intake_id;
  perform private.end_trusted_operation('scan_intake_resolution');
  perform private.emit_event(v_scan.org_id, 'scan_intake.resolved', 'scan_intake', v_scan.id, v_scan.project_id,
    jsonb_build_object('resolution', p_resolution, 'resolved_subject_table', p_subject_table, 'resolved_subject_id', p_subject_id));
  return now();
end;
$$;

comment on function app.resolve_scan_intake(uuid, app.scan_resolution, text, uuid, text) is 'Resolves an open scan once: Matched or Created name a record of the same org it resolved to; Dismissed needs a note. Needs credentials.scan.write on the scan''s project. Emits scan_intake.resolved.';
revoke all on function app.resolve_scan_intake(uuid, app.scan_resolution, text, uuid, text) from public, anon;
grant execute on function app.resolve_scan_intake(uuid, app.scan_resolution, text, uuid, text) to authenticated, service_role;

call private.install_policies('app.scan_intake',
  $$project_id in (select private.project_ids_with('credentials.scan_log.read')) or scanned_by = (select private.current_person_id())$$,
  $$project_id in (select private.project_ids_with('credentials.scan.write'))$$);

insert into private.sync_rpcs (rpc, description) values
  ('app.resolve_scan_intake', 'A supervisor resolves an unresolved scan from the field.');
