-- 0365_clock_punches.sql
-- A03 Domain Data (requested by A17 Compass). Clock punches captured offline on phones and kiosks:
--   * app.clock_punches: the append-only record of every punch as the device reported it (client id,
--     device time, monotonic offset, location and accuracy, geofence result, skew flag, source), with the
--     time entry it opened, changed or closed
--   * time_entries.auto_closed_at and needs_review, and private.close_stale_time_entries, which closes
--     entries left open longer than 16 hours and marks them for review
-- The punch RPC app.record_punch and the schedule of the close job live in the late slot (0941), because
-- they use the shift lifecycle (0460), pg_cron (0500s) and engagement_id (0940).

create type app.punch_kind as enum ('In', 'Break Start', 'Break End', 'Out');
comment on type app.punch_kind is 'Kinds of clock punch: In opens a time entry, Break Start and Break End bracket an unpaid break, Out closes the entry.';

create type app.punch_source as enum ('Mobile', 'Kiosk');
comment on type app.punch_source is 'Where a punch was captured: the person''s phone (Compass) or a shared kiosk.';

-- Time entries: automatic close ------------------------------------------------------------------------

alter table app.time_entries
  add column auto_closed_at timestamptz,
  add column needs_review boolean not null default false;

comment on column app.time_entries.auto_closed_at is 'When the platform closed an entry left open longer than 16 hours; NULL when the person or a correction closed it.';
comment on column app.time_entries.needs_review is 'True while an entry needs a supervisor''s review, for example after an automatic close or a skewed punch.';

create index time_entries_needs_review_idx on app.time_entries (org_id) where needs_review and deleted_at is null;
create index time_entries_open_idx on app.time_entries (clock_in) where clock_out is null and deleted_at is null;

create or replace function private.close_stale_time_entries(p_max_open interval default interval '16 hours')
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_closed integer;
begin
  update app.time_entries t
  set clock_out = t.clock_in + p_max_open, auto_closed_at = now(), needs_review = true
  where t.clock_out is null and t.deleted_at is null and t.clock_in < now() - p_max_open;
  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;

comment on function private.close_stale_time_entries(interval) is 'Closes every time entry open longer than the limit (16 hours by default) at clock in plus the limit, stamps auto_closed_at and marks it for review. The change is audited and voids any approval of its timesheet (invariant 19). Run by the platform job scheduled in the late slot; returns the number closed.';
revoke all on function private.close_stale_time_entries(interval) from public, anon, authenticated;
grant execute on function private.close_stale_time_entries(interval) to service_role;

-- Clock punches ------------------------------------------------------------------------------------------------

create table app.clock_punches (
  id uuid primary key,
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  membership_id uuid not null references app.memberships (id),
  shift_id uuid references app.shifts (id),
  time_entry_id uuid references app.time_entries (id),
  punch_kind app.punch_kind not null,
  device_time timestamptz not null,
  monotonic_offset_ms bigint,
  received_at timestamptz not null default now(),
  effective_at timestamptz not null,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  accuracy_m numeric(8, 1),
  geofence_id uuid references app.geofences (id),
  geofence_verified boolean,
  skew_flagged boolean not null default false,
  source app.punch_source not null,
  kiosk_device_id uuid references app.kiosk_devices (id),
  photo_uri text,
  constraint clock_punches_latitude_range check (latitude is null or latitude between -90 and 90),
  constraint clock_punches_longitude_range check (longitude is null or longitude between -180 and 180),
  constraint clock_punches_location_pair check ((latitude is null) = (longitude is null)),
  constraint clock_punches_accuracy check (accuracy_m is null or (accuracy_m >= 0 and latitude is not null)),
  constraint clock_punches_monotonic_nonnegative check (monotonic_offset_ms is null or monotonic_offset_ms >= 0),
  constraint clock_punches_kiosk check ((source = 'Kiosk') = (kiosk_device_id is not null)),
  constraint clock_punches_geofence_verified check (geofence_verified is null or geofence_id is not null),
  constraint clock_punches_photo_uri_length check (photo_uri is null or char_length(photo_uri) between 1 and 2000)
);

create index clock_punches_project_id_idx on app.clock_punches (project_id);
create index clock_punches_membership_id_idx on app.clock_punches (membership_id, effective_at);
create index clock_punches_shift_id_idx on app.clock_punches (shift_id);
create index clock_punches_time_entry_id_idx on app.clock_punches (time_entry_id);
create index clock_punches_geofence_id_idx on app.clock_punches (geofence_id);
create index clock_punches_kiosk_device_id_idx on app.clock_punches (kiosk_device_id);

call private.install_domain_table('app.clock_punches', 'app.projects', 'project_id',
  array['app.memberships', 'membership_id', 'app.shifts', 'shift_id', 'app.time_entries', 'time_entry_id',
        'app.geofences', 'geofence_id', 'app.kiosk_devices', 'kiosk_device_id'], true);
call private.describe('app.clock_punches', 'Append-only record of clock punches as devices reported them (Section 13). The id is the client id, so a replayed punch is recognized. Written only by app.record_punch, which opens, closes and breaks time entries from them.', array[
  'id', 'Client-generated punch id; a replay with the same id returns the stored punch.',
  'project_id', 'Project worked.',
  'membership_id', 'Membership of the person who punched.',
  'shift_id', 'Shift the punch works, when there is one.',
  'time_entry_id', 'Time entry the punch opened, broke or closed.',
  'punch_kind', 'In, Break Start, Break End or Out.',
  'device_time', 'Time on the device''s clock when the person punched.',
  'monotonic_offset_ms', 'Milliseconds on the device''s monotonic clock between the punch and its upload, to correct a wrong wall clock.',
  'received_at', 'When the server received the punch.',
  'effective_at', 'Time the punch counts at: the device time when it is within the skew tolerance, otherwise the time the server received it.',
  'latitude', 'WGS 84 latitude the device reported.',
  'longitude', 'WGS 84 longitude the device reported.',
  'accuracy_m', 'Reported accuracy radius in meters.',
  'geofence_id', 'Geofence the punch was checked against.',
  'geofence_verified', 'True when the server found the point inside the geofence (app.point_in_geofence), false when outside, NULL when not checked.',
  'skew_flagged', 'True when the device time fell outside the skew tolerance; the entry is marked for review.',
  'source', 'Mobile or Kiosk.',
  'kiosk_device_id', 'Kiosk the punch came from; Kiosk punches only.',
  'photo_uri', 'Storage path of the punch photo, when the kiosk or org takes one.'
]);

call private.install_policies('app.clock_punches',
  $$project_id in (select private.project_ids_with('crew.time_entry.read')) or membership_id in (select private.my_membership_ids())$$);
