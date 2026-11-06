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
--     on site by the rule of app.workforce_directory (1632: an open time entry clocked in within 24 hours with a
--     geofence-verified In punch) is in the zone of that punch's geofence, unless a scan places them at the same venue:
--     scans win.
--   * app.zone_counts_live: the scan presence counted by zone, category and engagement. The page sums the rows by zone
--     for the zone total, by category for the group and by engagement for the team. It counts people scanned in; it
--     is not a load count and never feeds the permitted-load alerts of app.occupancy_counters (0806, 1080).
--   * app.muster_list: the presence plus the guests checked in within the last 24 hours. A guest has no exit, so a
--     guest row says only that they came in. Guest rows come from the guest list itself (Checked In, by
--     checked_in_at), because a bulk check-in (2151) moves a guest to Checked In without a door check-in row; they need
--     advancing.packet.read, and the door and plus-ones of the door check-in show only to readers who may read the
--     check-ins (credentials.scan.write).
--
-- Every view carries the readable columns an export needs (zone code and name, the person's name, the credential
-- number, the category code and the party), as plain joins: collection exports read the columns of one view (2030).
-- A name the reader may not read through row level security (0204) is NULL there; the page fills it from
-- app.person_names.
--
-- A reader who cannot read a person's newer scan elsewhere may see that person in their last readable zone. The muster
-- list errs toward listing someone. The 24-hour windows keep every read on the newest partitions of access_scans
-- (1511) and time_entries (2231). Each view takes back the backup login's default SELECT (1650), and the columns that
-- show a classified column under another name are registered in private.view_column_sources (2030).

create view app.zone_presence with (security_invoker = on) as
with latest_scan as (
  select distinct on (s.org_id, cr.holder_person_id)
    s.org_id, s.project_id, z.venue_id, s.zone_id, cr.holder_person_id as person_id, s.credential_id,
    cr.credential_number, cr.credential_category_id, cc.code as category_code, cr.engagement_id,
    coalesce(s.device_scanned_at, s.scanned_at) as entered_at, s.direction
  from app.access_scans s
  join app.credentials cr on cr.id = s.credential_id
  join app.credential_categories cc on cc.id = cr.credential_category_id
  left join app.zones z on z.id = s.zone_id
  where s.created_at >= now() - interval '24 hours' and s.result = 'Granted' and cc.category_kind <> 'Parking'
  order by s.org_id, cr.holder_person_id, coalesce(s.device_scanned_at, s.scanned_at) desc, s.created_at desc, s.id desc
),
scan_presence as (
  select l.org_id, l.project_id, l.venue_id, l.zone_id, l.person_id, l.credential_id, l.credential_number,
    l.credential_category_id, l.category_code, l.engagement_id, l.entered_at
  from latest_scan l
  where l.direction = 'In'
),
-- 1632's on-site rule (open entry, clocked in within 24 hours, a geofence-verified In punch), plus the punch's zone.
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
  order by te.org_id, coalesce(m.person_id, e.person_id), te.clock_in desc, cp.effective_at desc
),
presence as (
  select sp.org_id, sp.project_id, sp.venue_id, sp.zone_id, sp.person_id, sp.credential_id, sp.credential_number,
    sp.credential_category_id, sp.category_code, sp.engagement_id, sp.entered_at, 'Scan'::text as source
  from scan_presence sp
  union all
  select cp.org_id, cp.project_id, cp.venue_id, cp.zone_id, cp.person_id, null::uuid, null::text, null::uuid, null::text,
    cp.engagement_id, cp.entered_at, 'Clock In'::text
  from clock_presence cp
  where cp.person_id is not null
    and not exists (select 1 from scan_presence sp where sp.org_id = cp.org_id and sp.person_id = cp.person_id
                    and sp.venue_id is not distinct from cp.venue_id)
)
select p.org_id, p.project_id, p.venue_id, p.zone_id, z.code as zone_code, z.name as zone_name, p.person_id,
  pe.full_name, p.credential_id, p.credential_number, p.credential_category_id, p.category_code, p.engagement_id,
  coalesce(a.name, ep.full_name) as party_name, p.entered_at, p.source
from presence p
left join app.zones z on z.id = p.zone_id
left join app.people pe on pe.id = p.person_id
left join app.engagements e on e.id = p.engagement_id
left join app.counterparties c on c.id = e.counterparty_id
left join app.organizations a on a.id = c.organization_id
left join app.people ep on ep.id = e.person_id;

call private.describe('app.zone_presence', 'Who is in which zone now (Section 4.2 Credentials, 4.9; ADR 0147 decision 3): one row per person, from their latest Granted gate scan within 24 hours across the org''s credentials (an Out scan places them nowhere; Parking categories are left out), or, by the on-site rule of app.workforce_directory (1632), from an open time entry clocked in within 24 hours whose geofence-verified In punch names a geofence with a zone, unless a scan places them at the same venue. Runs as the reader, so scans need credentials.scan_log.read and clock-ins crew.time_entry.read; a person whose newer scan elsewhere the reader cannot read shows in their last readable zone.', array[
  'org_id', 'Org.',
  'project_id', 'Project of the scan or the time entry.',
  'venue_id', 'Venue of the zone.',
  'zone_id', 'Zone the person is in.',
  'zone_code', 'Code of the zone.',
  'zone_name', 'Name of the zone.',
  'person_id', 'Person present.',
  'full_name', 'Person''s name, when the reader may read it.',
  'credential_id', 'Credential of the scan that placed them; NULL for a clock-in.',
  'credential_number', 'Number of that credential; NULL for a clock-in.',
  'credential_category_id', 'Category of that credential; NULL for a clock-in.',
  'category_code', 'Code of that category; NULL for a clock-in.',
  'engagement_id', 'Engagement of the credential or the time entry, when it has one.',
  'party_name', 'Supplying account of that engagement, else the engaged person.',
  'entered_at', 'When they entered: the scan''s device time, else its server time, or the clock-in punch''s effective time.',
  'source', 'Scan or Clock In.'
]);
revoke all on app.zone_presence from public, anon;
grant select on app.zone_presence to authenticated, service_role;
revoke select on app.zone_presence from xos_backup;

create view app.zone_counts_live with (security_invoker = on) as
select p.org_id, p.project_id, p.venue_id, p.zone_id, p.zone_code, p.zone_name, p.credential_category_id,
  p.category_code, p.engagement_id, p.party_name, count(*)::integer as inside, max(p.entered_at) as last_entry_at
from app.zone_presence p
where p.source = 'Scan'
group by p.org_id, p.project_id, p.venue_id, p.zone_id, p.zone_code, p.zone_name, p.credential_category_id,
  p.category_code, p.engagement_id, p.party_name;

call private.describe('app.zone_counts_live', 'Live counts of the people scanned into each zone (ADR 0147 decision 3), split by credential category and engagement; the rows of a zone sum to its total. People scanned in, not a load count: it never feeds the permitted-load alerts of app.occupancy_counters. Runs as the reader over app.zone_presence.', array[
  'org_id', 'Org.',
  'project_id', 'Project.',
  'venue_id', 'Venue of the zone.',
  'zone_id', 'Zone.',
  'zone_code', 'Code of the zone.',
  'zone_name', 'Name of the zone.',
  'credential_category_id', 'Credential category of the people counted.',
  'category_code', 'Code of that category.',
  'engagement_id', 'Engagement of the people counted, when their credential has one.',
  'party_name', 'Supplying account of that engagement, else the engaged person.',
  'inside', 'People inside now.',
  'last_entry_at', 'Latest entry among them.'
]);
revoke all on app.zone_counts_live from public, anon;
grant select on app.zone_counts_live to authenticated, service_role;
revoke select on app.zone_counts_live from xos_backup;

create view app.muster_list with (security_invoker = on) as
select p.org_id, p.project_id, p.venue_id, p.zone_id, p.zone_code, p.zone_name, p.person_id, p.full_name,
  null::text as guest_name, null::smallint as plus_ones, p.credential_id, p.credential_number, p.credential_category_id,
  p.category_code, p.engagement_id, p.party_name, p.entered_at, p.source, null::text as door
from app.zone_presence p
union all
select g.org_id, g.project_id, pr.venue_id, null::uuid, null::text, null::text, null::uuid, null::text, g.guest_name,
  c.plus_ones_admitted, null::uuid, null::text, null::uuid, null::text, g.engagement_id,
  coalesce(a.name, ep.full_name), g.checked_in_at, 'Guest Check In'::text, c.door
from app.guest_list_entries g
join app.projects pr on pr.id = g.project_id
left join app.guest_check_ins c on c.guest_list_entry_id = g.id and c.deleted_at is null
left join app.engagements e on e.id = g.engagement_id
left join app.counterparties cp on cp.id = e.counterparty_id
left join app.organizations a on a.id = cp.organization_id
left join app.people ep on ep.id = e.person_id
where g.entry_state = 'Checked In' and g.checked_in_at >= now() - interval '24 hours' and g.deleted_at is null;

call private.describe('app.muster_list', 'The muster list (Section 4.9, gap G-149): everyone app.zone_presence places in a zone now, plus the guests checked in within the last 24 hours, at a door or in bulk (2151), with their door and plus-ones when a door check-in recorded them. A guest has no exit, so a guest row says only that they came in. Runs as the reader: guest rows need advancing.packet.read on the project, and their door and plus-ones credentials.scan.write.', array[
  'org_id', 'Org.',
  'project_id', 'Project.',
  'venue_id', 'Venue of the zone, or of the project for a guest.',
  'zone_id', 'Zone; NULL for a guest.',
  'zone_code', 'Code of the zone; NULL for a guest.',
  'zone_name', 'Name of the zone; NULL for a guest.',
  'person_id', 'Person present; NULL for a guest.',
  'full_name', 'Person''s name, when the reader may read it; NULL for a guest.',
  'guest_name', 'Guest''s name; NULL for a person.',
  'plus_ones', 'Plus-ones admitted with the guest at the door.',
  'credential_id', 'Credential of the scan that placed the person.',
  'credential_number', 'Number of that credential.',
  'credential_category_id', 'Category of that credential.',
  'category_code', 'Code of that category.',
  'engagement_id', 'Engagement of the person or of the guest''s list.',
  'party_name', 'Supplying account of that engagement, else the engaged person.',
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
  ('app.muster_list', 'entered_at', 'app.guest_list_entries', 'checked_in_at'),
  ('app.zone_presence', 'party_name', 'app.organizations', 'name'),
  ('app.zone_presence', 'party_name', 'app.people', 'full_name'),
  ('app.zone_counts_live', 'party_name', 'app.organizations', 'name'),
  ('app.zone_counts_live', 'party_name', 'app.people', 'full_name'),
  ('app.zone_presence', 'zone_code', 'app.zones', 'code'),
  ('app.zone_presence', 'zone_name', 'app.zones', 'name'),
  ('app.zone_counts_live', 'zone_code', 'app.zones', 'code'),
  ('app.zone_counts_live', 'zone_name', 'app.zones', 'name'),
  ('app.zone_presence', 'category_code', 'app.credential_categories', 'code'),
  ('app.zone_counts_live', 'category_code', 'app.credential_categories', 'code'),
  ('app.muster_list', 'zone_code', 'app.zones', 'code'),
  ('app.muster_list', 'zone_name', 'app.zones', 'name'),
  ('app.muster_list', 'category_code', 'app.credential_categories', 'code'),
  ('app.muster_list', 'party_name', 'app.organizations', 'name'),
  ('app.muster_list', 'party_name', 'app.people', 'full_name');
