-- 2971_zone_presence.sql
-- B8 Live counts and muster lists (RRR-232, gaps G-145 and G-149, ADR 0147 decision 3). Who is in which zone now, read
-- from the gate scans and from geofenced clock-ins, as views that run as their reader (security_invoker), so the row
-- level security of the tables they read decides the rows:
--
--   * app.zone_presence: one row per person in a zone now. Presence is per person, never per credential: a person can
--     hold several live credentials (an Access badge and a Parking pass, or badges on two projects), so the latest
--     Granted scan of any of the org's credentials they hold within 24 hours places them, and an Out scan places them
--     nowhere. Parking categories count vehicles, not people, and are left out. Offline scans reach the server out of
--     order, so the latest is the latest device time (Compass always sends one), then the latest server time. A person
--     clocked in on an open time entry whose geofence-verified In punch names a geofence with a zone is in that zone,
--     unless a scan places them at the same venue: scans win.
--   * app.zone_counts_live: the scan presence counted by zone, category and engagement. The page sums the rows by zone
--     for the zone total, by category for the group and by engagement for the team.
--   * app.muster_list: the presence plus the guests checked in at doors in the last 24 hours. A guest has no exit, so
--     a guest row says only that they came in. Guest rows appear only to readers who may read both the guest list
--     (advancing.packet.read) and the door check-ins (credentials.scan.write).
--
-- A reader who cannot read a person's newer scan elsewhere may see that person in their last readable zone. The muster
-- list errs toward listing someone. The 24-hour windows keep every read on the newest partitions of access_scans
-- (1511) and time_entries (2231). Each view takes back the backup login's default SELECT (1650), and the columns that
-- show a classified column under another name are registered in private.view_column_sources (2030).

create view app.zone_presence with (security_invoker = on) as
with latest_scan as (
  select distinct on (s.org_id, cr.holder_person_id)
    s.org_id, s.project_id, z.venue_id, s.zone_id, cr.holder_person_id as person_id, s.credential_id,
    cr.credential_category_id, cr.engagement_id, coalesce(s.device_scanned_at, s.scanned_at) as entered_at, s.direction
  from app.access_scans s
  join app.credentials cr on cr.id = s.credential_id
  join app.credential_categories cc on cc.id = cr.credential_category_id
  left join app.zones z on z.id = s.zone_id
  where s.created_at >= now() - interval '24 hours' and s.result = 'Granted' and cc.category_kind <> 'Parking'
  order by s.org_id, cr.holder_person_id, coalesce(s.device_scanned_at, s.scanned_at) desc, s.created_at desc
),
scan_presence as (
  select l.org_id, l.project_id, l.venue_id, l.zone_id, l.person_id, l.credential_id, l.credential_category_id,
    l.engagement_id, l.entered_at
  from latest_scan l
  where l.direction = 'In'
),
clock_presence as (
  select distinct on (te.org_id, coalesce(m.person_id, e.person_id))
    te.org_id, te.project_id, z.venue_id, g.zone_id, coalesce(m.person_id, e.person_id) as person_id,
    te.engagement_id, cp.effective_at as entered_at
  from app.time_entries te
  join app.clock_punches cp on cp.time_entry_id = te.id and cp.punch_kind = 'In' and cp.geofence_verified
    and cp.deleted_at is null
  join app.geofences g on g.id = cp.geofence_id and g.zone_id is not null and g.deleted_at is null
  join app.zones z on z.id = g.zone_id
  left join app.memberships m on m.id = te.membership_id
  left join app.engagements e on e.id = te.engagement_id
  where te.clock_out is null and te.deleted_at is null and te.clock_in >= now() - interval '24 hours'
    and te.created_at >= now() - interval '48 hours'
  order by te.org_id, coalesce(m.person_id, e.person_id), cp.effective_at desc
)
select sp.org_id, sp.project_id, sp.venue_id, sp.zone_id, sp.person_id, sp.credential_id, sp.credential_category_id,
  sp.engagement_id, sp.entered_at, 'Scan'::text as source
from scan_presence sp
union all
select cp.org_id, cp.project_id, cp.venue_id, cp.zone_id, cp.person_id, null::uuid, null::uuid, cp.engagement_id,
  cp.entered_at, 'Clock In'::text
from clock_presence cp
where cp.person_id is not null
  and not exists (select 1 from scan_presence sp where sp.org_id = cp.org_id and sp.person_id = cp.person_id
                  and sp.venue_id is not distinct from cp.venue_id);

call private.describe('app.zone_presence', 'Who is in which zone now (Section 4.2 Credentials, 4.9; ADR 0147 decision 3): one row per person, from their latest Granted gate scan within 24 hours across the org''s credentials (an Out scan places them nowhere; Parking categories are left out), or from an open time entry whose geofence-verified In punch names a geofence with a zone, unless a scan places them at the same venue. Runs as the reader, so scans need credentials.scan_log.read and clock-ins crew.time_entry.read; a person whose newer scan elsewhere the reader cannot read shows in their last readable zone.', array[
  'org_id', 'Org.',
  'project_id', 'Project of the scan or the time entry.',
  'venue_id', 'Venue of the zone.',
  'zone_id', 'Zone the person is in.',
  'person_id', 'Person present.',
  'credential_id', 'Credential of the scan that placed them; NULL for a clock-in.',
  'credential_category_id', 'Category of that credential; NULL for a clock-in.',
  'engagement_id', 'Engagement of the credential or the time entry, when it has one.',
  'entered_at', 'When they entered: the scan''s device time, else its server time, or the clock-in punch''s effective time.',
  'source', 'Scan or Clock In.'
]);
revoke all on app.zone_presence from public, anon;
grant select on app.zone_presence to authenticated, service_role;
revoke select on app.zone_presence from xos_backup;

create view app.zone_counts_live with (security_invoker = on) as
select p.org_id, p.project_id, p.venue_id, p.zone_id, p.credential_category_id, p.engagement_id,
  count(*)::integer as inside, max(p.entered_at) as last_entry_at
from app.zone_presence p
where p.source = 'Scan'
group by p.org_id, p.project_id, p.venue_id, p.zone_id, p.credential_category_id, p.engagement_id;

call private.describe('app.zone_counts_live', 'Live counts of the people scanned into each zone (ADR 0147 decision 3), split by credential category and engagement; the rows of a zone sum to its total. Runs as the reader over app.zone_presence.', array[
  'org_id', 'Org.',
  'project_id', 'Project.',
  'venue_id', 'Venue of the zone.',
  'zone_id', 'Zone.',
  'credential_category_id', 'Credential category of the people counted.',
  'engagement_id', 'Engagement of the people counted, when their credential has one.',
  'inside', 'People inside now.',
  'last_entry_at', 'Latest entry among them.'
]);
revoke all on app.zone_counts_live from public, anon;
grant select on app.zone_counts_live to authenticated, service_role;
revoke select on app.zone_counts_live from xos_backup;

create view app.muster_list with (security_invoker = on) as
select p.org_id, p.project_id, p.venue_id, p.zone_id, p.person_id, null::text as guest_name, null::smallint as plus_ones,
  p.credential_id, p.credential_category_id, p.engagement_id, p.entered_at, p.source, null::text as door
from app.zone_presence p
union all
select c.org_id, g.project_id, pr.venue_id, null::uuid, null::uuid, g.guest_name, c.plus_ones_admitted, null::uuid,
  null::uuid, g.engagement_id, c.created_at, 'Guest Check In'::text, c.door
from app.guest_check_ins c
join app.guest_list_entries g on g.id = c.guest_list_entry_id and g.deleted_at is null
join app.projects pr on pr.id = g.project_id
where c.created_at >= now() - interval '24 hours' and c.deleted_at is null;

call private.describe('app.muster_list', 'The muster list (Section 4.9, gap G-149): everyone app.zone_presence places in a zone now, plus the guests checked in at doors in the last 24 hours with their plus-ones and door. A guest has no exit, so a guest row says only that they came in. Runs as the reader: guest rows need advancing.packet.read and credentials.scan.write on the project. Names are filled by the data layer.', array[
  'org_id', 'Org.',
  'project_id', 'Project.',
  'venue_id', 'Venue of the zone, or of the project for a guest.',
  'zone_id', 'Zone; NULL for a guest.',
  'person_id', 'Person present; NULL for a guest.',
  'guest_name', 'Guest''s name; NULL for a person.',
  'plus_ones', 'Plus-ones admitted with the guest.',
  'credential_id', 'Credential of the scan that placed the person.',
  'credential_category_id', 'Category of that credential.',
  'engagement_id', 'Engagement of the person or of the guest''s list.',
  'entered_at', 'When the person entered, or the guest was checked in.',
  'source', 'Scan, Clock In or Guest Check In.',
  'door', 'Door a guest was checked in at.'
]);
revoke all on app.muster_list from public, anon;
grant select on app.muster_list to authenticated, service_role;
revoke select on app.muster_list from xos_backup;

-- Columns that show another column, for export classification (2030) --------------------------------------------------

insert into private.view_column_sources (view_name, column_name, source_table, source_column) values
  ('app.zone_presence', 'person_id', 'app.credentials', 'holder_person_id'),
  ('app.zone_presence', 'person_id', 'app.memberships', 'person_id'),
  ('app.zone_presence', 'person_id', 'app.engagements', 'person_id'),
  ('app.zone_presence', 'entered_at', 'app.access_scans', 'device_scanned_at'),
  ('app.zone_presence', 'entered_at', 'app.access_scans', 'scanned_at'),
  ('app.zone_presence', 'entered_at', 'app.clock_punches', 'effective_at'),
  ('app.zone_counts_live', 'last_entry_at', 'app.access_scans', 'scanned_at'),
  ('app.muster_list', 'person_id', 'app.credentials', 'holder_person_id'),
  ('app.muster_list', 'person_id', 'app.memberships', 'person_id'),
  ('app.muster_list', 'person_id', 'app.engagements', 'person_id'),
  ('app.muster_list', 'plus_ones', 'app.guest_check_ins', 'plus_ones_admitted'),
  ('app.muster_list', 'entered_at', 'app.access_scans', 'device_scanned_at'),
  ('app.muster_list', 'entered_at', 'app.access_scans', 'scanned_at'),
  ('app.muster_list', 'entered_at', 'app.clock_punches', 'effective_at'),
  ('app.muster_list', 'entered_at', 'app.guest_check_ins', 'created_at');
