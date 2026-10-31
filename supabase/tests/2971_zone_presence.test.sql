-- pgTAP: migration 2971 (B8, G-145, G-149), zone presence, live counts and the muster list. Presence by the latest
-- Granted scan per person; entering zone B leaves A; Out ends presence; scans older than 24 hours and Parking passes are
-- ignored; a geofenced clock-in places a person unless a scan places them at the same venue; counts split by category
-- and engagement sum to the zone total; guests checked in at doors join the muster list; row level security decides
-- what each reader sees; the backup login reads none of the views; the read stays on recent partitions.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select no_plan();

-- Fixture ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'FOH', 'Front of House') returning id) insert into world select 'zone_a', id from x;
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'STG', 'Stage') returning id) insert into world select 'zone_b', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id) insert into world select 'cat', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'PROD', 'Production') returning id) insert into world select 'cat_prod', id from x;
with x as (insert into app.credential_categories (project_id, code, name, category_kind) values (pg_temp.id('prj_a'), 'PARK', 'Parking', 'Parking') returning id) insert into world select 'cat_park', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a2'), 'GALA', 'Gala Crew') returning id) insert into world select 'cat_a2', id from x;
insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
select c, z, 'ENM-036', now() - interval '1 day', now() + interval '1 day'
from unnest(array[pg_temp.id('cat'), pg_temp.id('cat_prod'), pg_temp.id('cat_park'), pg_temp.id('cat_a2')]) c,
     unnest(array[pg_temp.id('zone_a'), pg_temp.id('zone_b')]) z;
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('frank')) returning id) insert into world select 'cred_frank', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('erin')) returning id) insert into world select 'cred_erin', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat_prod'), pg_temp.id('bob')) returning id) insert into world select 'cred_bob', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat_park'), pg_temp.id('dave')) returning id) insert into world select 'cred_park', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('gina')) returning id) insert into world select 'cred_gina', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat_a2'), pg_temp.id('mia')) returning id) insert into world select 'cred_a2', id from x;

-- Scans (one transaction, so each carries its device time to order them) ---------------------------------------------------
select pg_temp.as_user('carol');
select app.record_scan(pg_temp.id('zone_a'), pg_temp.id('cred_frank'), null, null, now() - interval '20 minutes', 'Granted');
select app.record_scan(pg_temp.id('zone_b'), pg_temp.id('cred_frank'), null, null, now() - interval '10 minutes', 'Granted');
select app.record_scan(pg_temp.id('zone_a'), pg_temp.id('cred_erin'), null, null, now() - interval '30 minutes', 'Granted');
select app.record_scan(pg_temp.id('zone_a'), pg_temp.id('cred_erin'), null, null, now() - interval '5 minutes', 'Granted', 'Out');
select app.record_scan(pg_temp.id('zone_a'), pg_temp.id('cred_bob'), null, null, now() - interval '15 minutes', 'Granted');
select app.record_scan(pg_temp.id('zone_a'), pg_temp.id('cred_park'), null, null, now() - interval '15 minutes', 'Granted');
insert into world select 'old_scan', id from app.record_scan(pg_temp.id('zone_a'), pg_temp.id('cred_gina'));
select app.record_scan(pg_temp.id('zone_b'), pg_temp.id('cred_a2'), null, null, now() - interval '3 minutes', 'Granted');

-- gina's scan is older than 24 hours, and an old month's partition holds a row
select pg_temp.as_platform();
set local session_replication_role = replica;
update app.access_scans set created_at = now() - interval '25 hours', scanned_at = now() - interval '25 hours' where id = pg_temp.id('old_scan');
set local session_replication_role = origin;
select private.create_month_partition('app.access_scans', (date_trunc('month', now() at time zone 'UTC') - interval '4 months')::date);
set local session_replication_role = replica;
insert into app.access_scans (id, org_id, project_id, credential_id, zone_id, scanned_at, result, created_at)
values (gen_random_uuid(), pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('cred_gina'), pg_temp.id('zone_a'),
        now() - interval '4 months', 'Granted', (date_trunc('month', now() at time zone 'UTC') - interval '4 months' + interval '2 days') at time zone 'UTC');

-- Clock-ins: dave on a geofence of zone A, frank on the same geofence (his scan wins) -------------------------------------
with x as (insert into app.geofences (id, org_id, venue_id, zone_id, name, boundary)
  values (gen_random_uuid(), pg_temp.id('org_a'), pg_temp.id('venue_a'), pg_temp.id('zone_a'), 'Front lawn',
          'SRID=4326;POLYGON((-80.2 25.8,-80.19 25.8,-80.19 25.81,-80.2 25.81,-80.2 25.8))'::extensions.geography)
  returning id) insert into world select 'geofence', id from x;
insert into app.time_entries (id, org_id, project_id, membership_id, clock_in, created_at)
values ('01920000-0000-7000-8000-00000000c971', pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), now() - interval '2 hours', now()),
       ('01920000-0000-7000-8000-00000000c972', pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), now() - interval '2 hours', now());
insert into app.clock_punches (id, org_id, project_id, membership_id, time_entry_id, time_entry_created_at, punch_kind, device_time,
  effective_at, geofence_id, geofence_verified, source)
values (gen_random_uuid(), pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), '01920000-0000-7000-8000-00000000c971', now(),
        'In', now() - interval '2 hours', now() - interval '2 hours', pg_temp.id('geofence'), true, 'Mobile'),
       (gen_random_uuid(), pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '01920000-0000-7000-8000-00000000c972', now(),
        'In', now() - interval '2 hours', now() - interval '2 hours', pg_temp.id('geofence'), true, 'Mobile');
set local session_replication_role = origin;

-- Guests: one checked in at a door ---------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name, plus_ones, entry_state) values (pg_temp.id('prj_a'), 'Sasha Bell', 2, 'Approved') returning id)
  insert into world select 'guest', id from x;
select pg_temp.as_user('frank');
select app.check_in_guest(pg_temp.id('guest'), 1::smallint, 'North Gate');

-- Presence ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select array_agg(zone_id) from app.zone_presence where person_id = pg_temp.id('frank')), array[pg_temp.id('zone_b')],
  'entering zone B leaves zone A, and the scan wins over frank''s clock-in at the same venue');
select is((select source from app.zone_presence where person_id = pg_temp.id('frank')), 'Scan', 'frank is present by scan');
select is((select count(*)::int from app.zone_presence where person_id = pg_temp.id('erin')), 0, 'an Out scan ends presence');
select is((select count(*)::int from app.zone_presence where person_id = pg_temp.id('gina')), 0, 'a scan older than 24 hours is ignored');
select is((select count(*)::int from app.zone_presence where person_id = pg_temp.id('dave') and source = 'Scan'), 0, 'a Parking pass places nobody');
select is((select row(zone_id = pg_temp.id('zone_a'), source)::text from app.zone_presence where person_id = pg_temp.id('dave')), '(t,"Clock In")',
  'a geofence-verified clock-in places dave in the geofence''s zone');
select is((select credential_category_id from app.zone_presence where person_id = pg_temp.id('bob')), pg_temp.id('cat_prod'), 'a scan row carries its category');
select is((select venue_id from app.zone_presence where person_id = pg_temp.id('frank')), pg_temp.id('venue_a'), 'and the zone''s venue');

-- Counts ---------------------------------------------------------------------------------------------------------------------
select is((select sum(inside)::int from app.zone_counts_live where zone_id = pg_temp.id('zone_a')),
  (select count(*)::int from app.zone_presence where zone_id = pg_temp.id('zone_a') and source = 'Scan'), 'zone A''s rows sum to its scan presence');
select is((select sum(inside)::int from app.zone_counts_live where zone_id = pg_temp.id('zone_b')), 2, 'zone B counts frank and the gala crew member');
select is((select count(*)::int from app.zone_counts_live where zone_id = pg_temp.id('zone_b')), 2, 'split by category and project');

-- Muster list ----------------------------------------------------------------------------------------------------------------
select is((select row(guest_name, plus_ones, door, source, zone_id is null)::text from app.muster_list where guest_name is not null),
  '("Sasha Bell",1,"North Gate","Guest Check In",t)', 'a guest checked in at a door joins the muster list with plus-ones and door');
select is((select count(*)::int from app.muster_list where person_id is not null),
  (select count(*)::int from app.zone_presence), 'every present person is on the muster list');

-- Row level security ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select count(*)::int from app.zone_presence where project_id = pg_temp.id('prj_a2')), 0,
  'a Field member without credentials.scan_log.read on NWX sees no scan presence there');
select pg_temp.as_user('erin');
select is((select count(*)::int from app.zone_presence where source = 'Clock In'), 0,
  'a Collaborator without crew.time_entry.read sees no clock-in presence');
select ok((select count(*) from app.zone_presence where source = 'Scan') > 0, 'but sees the scans of a project they are assigned to');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.muster_list where source = 'Guest Check In'), 0,
  'a Viewer without credentials.scan.write sees no guest rows');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.muster_list), 0, 'another org sees nothing');
select pg_temp.as_anon();
select throws_ok($$select * from app.zone_presence$$, '42501', null, 'anon cannot read presence');
select pg_temp.as_platform();

select ok(not has_table_privilege('xos_backup', 'app.zone_presence', 'select'), 'xos_backup has no select on app.zone_presence');
select ok(not has_table_privilege('xos_backup', 'app.zone_counts_live', 'select'), 'xos_backup has no select on app.zone_counts_live');
select ok(not has_table_privilege('xos_backup', 'app.muster_list', 'select'), 'xos_backup has no select on app.muster_list');
select ok((select bool_and(coalesce('security_invoker=on' = any (c.reloptions), false)) from pg_catalog.pg_class c
           where c.oid in ('app.zone_presence'::regclass, 'app.zone_counts_live'::regclass, 'app.muster_list'::regclass)),
  'the three views run as their reader');

-- The read stays on recent partitions ---------------------------------------------------------------------------------------
create function pg_temp.presence_plan() returns text language plpgsql as $$
declare
  v json;
begin
  execute 'explain (format json) select * from app.zone_presence' into v;
  return v::text;
end $$;
select ok(position(split_part(private.partition_name('app.access_scans', (date_trunc('month', now() at time zone 'UTC') - interval '4 months')::date), '.', 2)
                   in pg_temp.presence_plan()) = 0,
  'the plan of app.zone_presence leaves out a partition older than its 24-hour window');
select ok(position('access_scans_p' in pg_temp.presence_plan()) > 0 or position('Subplans Removed' in pg_temp.presence_plan()) > 0,
  'and reads the partitions that overlap it');

select * from finish();
rollback;
