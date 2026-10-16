-- 1022_external_compass_sync_views.sql
-- A32 Gateway and Compass follow-up (RRR-76), late slot. Compass syncs external devices through PowerSync, which
-- replicates base tables only, so packages/sync/sync-rules.yaml selects explicit columns for external buckets. Each
-- external column list must equal an api_external projection (Section 8.7, ADR 0019 item 5). A26's readiness check
-- found three tables external buckets read with no projection; these views are that allowlist, and Compass's REST
-- downloader reads them when PowerSync is not configured:
--   * api_external.projects: the projects the caller reaches through an operational engagement (name, time zone)
--   * api_external.radio_channels: the radio channel plan of those projects (Section 4.3, Reference)
--   * api_external.clock_punches: the caller's own punches under their engagements, so Compass derives the clock
--     state offline; location, photo and kiosk details never appear
-- Every row filter uses the 0710 helpers with column values (ADR 0016 item 14).

create view api_external.projects as
select p.id, p.org_id, p.name, p.time_zone, p.venue_id
from app.projects p
where p.deleted_at is null and private.is_engaged_party(p.id);

call private.describe('api_external.projects', 'Projects the caller reaches through an engagement whose operational area is open (Section 8.7): name and time zone for Compass headers and times. Budgets, phases, client and internal state never appear.', array[
  'id', 'Project.', 'org_id', 'Organization running the project.', 'name', 'Project name.', 'time_zone', 'IANA time zone of the project.',
  'venue_id', 'Venue of the project, when set.']);

create view api_external.radio_channels as
select r.id, r.project_id, r.channel_number, r.name, r.zone_id
from app.radio_channels r
where r.deleted_at is null and private.is_engaged_party(r.project_id);

call private.describe('api_external.radio_channels', 'Radio channel plan of the projects the caller works on through an open operational engagement (Section 4.3 Reference), available offline in Compass.', array[
  'id', 'Radio channel.', 'project_id', 'Project.', 'channel_number', 'Channel number.', 'name', 'Channel name.', 'zone_id', 'Zone the channel serves, when set.']);

create view api_external.clock_punches as
select c.id, c.engagement_id, c.project_id, c.shift_id, c.time_entry_id, c.punch_kind, c.device_time, c.effective_at,
  c.geofence_verified, c.skew_flagged, c.source
from app.clock_punches c
where c.deleted_at is null and c.engagement_id in (select private.my_engagement_ids('operational'));

call private.describe('api_external.clock_punches', 'The caller''s own clock punches under their engagements while the operational area is open, so Compass shows the clock state offline. Location, photo and kiosk device never appear. Recorded through app.record_punch.', array[
  'id', 'Punch.', 'engagement_id', 'Engagement punched under.', 'project_id', 'Project.', 'shift_id', 'Shift punched for.',
  'time_entry_id', 'Time entry the punch opened or closed.', 'punch_kind', 'Clock in, clock out or a break punch.',
  'device_time', 'Time on the device when punched.', 'effective_at', 'Time the punch counts from.',
  'geofence_verified', 'True when the punch was inside the venue geofence.', 'skew_flagged', 'True when the device clock looked wrong.',
  'source', 'Where the punch was captured.']);

revoke all on api_external.projects, api_external.radio_channels, api_external.clock_punches from public, anon;
grant select on api_external.projects, api_external.radio_channels, api_external.clock_punches to authenticated, service_role;
