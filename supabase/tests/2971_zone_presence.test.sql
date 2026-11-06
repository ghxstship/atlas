-- pgTAP: migration 2971 (B8, G-145, G-149), zone presence, live counts and the muster list. Presence by the latest
-- Granted scan per person; entering zone B leaves A; Out ends presence; scans older than 24 hours and Parking passes are
-- ignored; a geofenced clock-in places a person unless a scan places them at the same venue; counts split by category
-- and engagement sum to the zone total; guests checked in at a door or in bulk join the muster list; the readable
-- columns an export needs are there; row level security decides what each reader sees, and a non-member reads every
-- column without a crash (ADR 0016 rule 14); an engaged external's name and every party's name reach a scan reader who
-- may read neither people nor engagements, and nobody else; a time-entry reader who may read neither memberships nor
-- engagements still sees a clock-in; the views scan none of those tables; a clock-in after an Out places the person and
-- one before it does not; a device time past 24 hours places nobody; the backup login reads none of the views; the read
-- stays on recent partitions.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

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
with x as (insert into app.credentials (credential_category_id, holder_person_id, engagement_id) values (pg_temp.id('cat'), pg_temp.id('ivy'), pg_temp.id('eng_ivy_a')) returning id) insert into world select 'cred_ivy', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id, engagement_id) values (pg_temp.id('cat'), pg_temp.id('sam'), pg_temp.id('eng_vendor_a')) returning id) insert into world select 'cred_sam', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('paul')) returning id) insert into world select 'cred_paul', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('cora')) returning id) insert into world select 'cred_cora', id from x;
select pg_temp.as_user('alice');
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('carol')) returning id) insert into world select 'cred_carol', id from x;
select pg_temp.as_user('carol');
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('alice')) returning id) insert into world select 'cred_alice', id from x;

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
select app.record_scan(pg_temp.id('zone_a'), pg_temp.id('cred_ivy'), null, null, now() - interval '4 minutes', 'Granted');
select app.record_scan(pg_temp.id('zone_a'), pg_temp.id('cred_sam'), null, null, now() - interval '4 minutes', 'Granted');
-- paul's scan uploads now with a device time 30 hours ago: it reached the server inside 24 hours but happened outside them.
select app.record_scan(pg_temp.id('zone_a'), pg_temp.id('cred_paul'), null, null, now() - interval '30 hours', 'Granted');
-- carol clocks in, comes in by scan and leaves by scan; alice leaves by scan and then clocks in again.
select app.record_scan(pg_temp.id('zone_a'), pg_temp.id('cred_carol'), null, null, now() - interval '90 minutes', 'Granted');
select app.record_scan(pg_temp.id('zone_a'), pg_temp.id('cred_carol'), null, null, now() - interval '30 minutes', 'Granted', 'Out');
select app.record_scan(pg_temp.id('zone_a'), pg_temp.id('cred_alice'), null, null, now() - interval '90 minutes', 'Granted');
select app.record_scan(pg_temp.id('zone_a'), pg_temp.id('cred_alice'), null, null, now() - interval '30 minutes', 'Granted', 'Out');

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
       ('01920000-0000-7000-8000-00000000c972', pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), now() - interval '2 hours', now()),
       ('01920000-0000-7000-8000-00000000c973', pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('carol@org_a'), now() - interval '2 hours', now()),
       ('01920000-0000-7000-8000-00000000c974', pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('alice@org_a'), now() - interval '10 minutes', now());
insert into app.clock_punches (id, org_id, project_id, membership_id, time_entry_id, time_entry_created_at, punch_kind, device_time,
  effective_at, geofence_id, geofence_verified, source)
values (gen_random_uuid(), pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), '01920000-0000-7000-8000-00000000c971', now(),
        'In', now() - interval '2 hours', now() - interval '2 hours', pg_temp.id('geofence'), true, 'Mobile'),
       (gen_random_uuid(), pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '01920000-0000-7000-8000-00000000c972', now(),
        'In', now() - interval '2 hours', now() - interval '2 hours', pg_temp.id('geofence'), true, 'Mobile'),
       (gen_random_uuid(), pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('carol@org_a'), '01920000-0000-7000-8000-00000000c973', now(),
        'In', now() - interval '2 hours', now() - interval '2 hours', pg_temp.id('geofence'), true, 'Mobile'),
       (gen_random_uuid(), pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('alice@org_a'), '01920000-0000-7000-8000-00000000c974', now(),
        'In', now() - interval '10 minutes', now() - interval '10 minutes', pg_temp.id('geofence'), true, 'Mobile');
set local session_replication_role = origin;

-- Guests: one checked in at a door ---------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name, plus_ones, entry_state) values (pg_temp.id('prj_a'), 'Sasha Bell', 2, 'Approved') returning id)
  insert into world select 'guest', id from x;
with x as (insert into app.guest_list_entries (project_id, guest_name, plus_ones, entry_state) values (pg_temp.id('prj_a'), 'Rory Vale', 0, 'Approved') returning id)
  insert into world select 'guest_bulk', id from x;
select pg_temp.as_user('frank');
select app.check_in_guest(pg_temp.id('guest'), 1::smallint, 'North Gate');
-- A bulk check-in (2151) moves the guest to Checked In with no door check-in row.
select is(app.bulk_update_guest_list_entries(jsonb_build_array(jsonb_build_object('id', pg_temp.id('guest_bulk'),
  'set', jsonb_build_object('entry_state', 'Checked In')))) ->> 'changed', '1', 'frank checks a second guest in in bulk');

-- Presence ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select array_agg(zone_id) from app.zone_presence where person_id = pg_temp.id('frank')), array[pg_temp.id('zone_b')],
  'entering zone B leaves zone A, and the scan wins over frank''s clock-in at the same venue');
select is((select source from app.zone_presence where person_id = pg_temp.id('frank')), 'Scan', 'frank is present by scan');
select is((select count(*)::int from app.zone_presence where person_id = pg_temp.id('erin')), 0, 'an Out scan ends presence');
select is((select count(*)::int from app.zone_presence where person_id = pg_temp.id('gina')), 0, 'a scan older than 24 hours is ignored');
select is((select count(*)::int from app.zone_presence where person_id = pg_temp.id('paul')), 0,
  'a scan uploaded now with a device time 30 hours ago places nobody');
select is((select count(*)::int from app.zone_presence where person_id = pg_temp.id('carol')), 0,
  'someone who clocked in and then scanned Out is in no zone');
select is((select source from app.zone_presence where person_id = pg_temp.id('alice')), 'Clock In',
  'a clock-in after the Out means they came back');
select is((select count(*)::int from app.zone_presence where person_id = pg_temp.id('dave') and source = 'Scan'), 0, 'a Parking pass places nobody');
select is((select row(zone_id = pg_temp.id('zone_a'), source)::text from app.zone_presence where person_id = pg_temp.id('dave')), '(t,"Clock In")',
  'a geofence-verified clock-in places dave in the geofence''s zone');
select is((select credential_category_id from app.zone_presence where person_id = pg_temp.id('bob')), pg_temp.id('cat_prod'), 'a scan row carries its category');
select is((select venue_id from app.zone_presence where person_id = pg_temp.id('frank')), pg_temp.id('venue_a'), 'and the zone''s venue');
select is((select row(zone_code, zone_name, category_code, credential_number = (select credential_number from app.credentials where id = pg_temp.id('cred_frank')))::text
           from app.zone_presence where person_id = pg_temp.id('frank')), '(STG,Stage,CREW,t)',
  'a row carries the zone code and name, the category code and the credential number, for export');
select is((select full_name from app.zone_presence where person_id = pg_temp.id('frank')),
  (select full_name from app.people where id = pg_temp.id('frank')), 'and the name of a member of the reader''s org');
select is((select row(zone_code, credential_number is null, category_code is null)::text from app.zone_presence where person_id = pg_temp.id('dave')),
  '(FOH,t,t)', 'a clock-in row carries its zone and no credential');

-- Counts ---------------------------------------------------------------------------------------------------------------------
select is((select sum(inside)::int from app.zone_counts_live where zone_id = pg_temp.id('zone_a')),
  (select count(*)::int from app.zone_presence where zone_id = pg_temp.id('zone_a') and source = 'Scan'), 'zone A''s rows sum to its scan presence');
select is((select sum(inside)::int from app.zone_counts_live where zone_id = pg_temp.id('zone_b')), 2, 'zone B counts frank and the gala crew member');
select is((select row(zone_id, category_code)::text from app.zone_counts_live where engagement_id = pg_temp.id('eng_ivy_a')),
  row(pg_temp.id('zone_a'), 'CREW')::text, 'a count splits by engagement');
select is((select string_agg(distinct zone_code || ':' || category_code, ',') from app.zone_counts_live where zone_id = pg_temp.id('zone_b')),
  'STG:CREW,STG:GALA', 'and names the zone and the categories it counts');
select is((select count(*)::int from app.zone_counts_live where zone_id = pg_temp.id('zone_b')), 2, 'split by category and project');

-- Muster list ----------------------------------------------------------------------------------------------------------------
select is((select row(guest_name, plus_ones, door, source, zone_id is null)::text from app.muster_list where guest_name = 'Sasha Bell'),
  '("Sasha Bell",1,"North Gate","Guest Check In",t)', 'a guest checked in at a door joins the muster list with plus-ones and door');
select is((select row(guest_name, plus_ones, door, source, entered_at = (select checked_in_at from app.guest_list_entries where id = pg_temp.id('guest_bulk')))::text
           from app.muster_list where guest_name = 'Rory Vale'),
  '("Rory Vale",,,"Guest Check In",t)', 'a guest checked in in bulk joins it too, at the check-in time, with no door');
select is((select count(*)::int from app.muster_list where person_id is not null),
  (select count(*)::int from app.zone_presence), 'every present person is on the muster list');

-- Names: a scan reader may read neither people nor engagements (seed role field) ---------------------------------------------
select pg_temp.as_user('frank');
select is((select row(full_name, party_name)::text from app.zone_presence where person_id = pg_temp.id('ivy')),
  '("Ivy Marchetti","Ivy Marchetti")', 'an engaged external and an individual party are named for a Field scan reader');
select is((select row(full_name, party_name)::text from app.muster_list where person_id = pg_temp.id('ivy')),
  '("Ivy Marchetti","Ivy Marchetti")', 'on the muster list too');
select is((select row(full_name, party_name)::text from app.zone_presence where person_id = pg_temp.id('sam')),
  '("Sam Kowalski","Bayside Audio")', 'and an account party, a counterparty organization the reader cannot read');
select is((select party_name from app.muster_list where person_id = pg_temp.id('sam')), 'Bayside Audio', 'on the muster list too');
select is((select party_name from app.zone_counts_live where engagement_id = pg_temp.id('eng_vendor_a')), 'Bayside Audio', 'and on the counts');
select lives_ok($$select * from app.zone_presence, app.zone_counts_live, app.muster_list$$, 'a Field reader selects every column without a crash');
select is((select count(*)::int from app.people where id = pg_temp.id('ivy')), 0, 'though app.people still hides her');
-- Callers have no usage on the private schema, and a view reaches the helpers without it, as these views do.
select pg_temp.as_platform();
create temporary view presence_answers with (security_invoker = on) as
  select (select n.full_name from private.presence_person_names(array[pg_temp.id('prj_a')], array[pg_temp.id('ivy')]) n) as person,
    (select n.party_name from private.presence_party_names(array[pg_temp.id('prj_a')], array[pg_temp.id('eng_vendor_a')]) n) as party,
    (select n.party_name from private.presence_party_names(array[pg_temp.id('prj_a')], array[pg_temp.id('eng_ivy_b')]) n) as other_project;
grant select on presence_answers to public;
select pg_temp.as_user('xavier');
select is((select person from presence_answers), null, 'a reader holding none of the three capabilities on the project gets no name');
select is((select party from presence_answers), null, 'nor a party');
select pg_temp.as_user('frank');
select is((select person from presence_answers), 'Ivy Marchetti', 'a reader holding one gets the name');
select is((select party from presence_answers), 'Bayside Audio', 'and the party');
select is((select other_project from presence_answers), null, 'an engagement of another project answers nothing');

-- A clock-in reached by a project grant, for a reader of neither memberships nor engagements ------------------------------------
select pg_temp.as_platform();
insert into private.project_role_capabilities (project_role, capability_code) values ('Field', 'crew.time_entry.read');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.memberships where id = pg_temp.id('dave@org_a')), 0, 'frank cannot read dave''s membership');
select is((select row(source, full_name is not null)::text from app.zone_presence where person_id = pg_temp.id('dave')), '("Clock In",t)',
  'but a crew.time_entry.read reader sees dave''s clock-in, named');
select pg_temp.as_platform();
delete from private.project_role_capabilities where project_role = 'Field' and capability_code = 'crew.time_entry.read';

-- The views scan none of the tables whose policies would re-read them (ADR 0016 rule 14) ------------------------------------------
select ok(pg_catalog.pg_get_viewdef('app.zone_presence'::regclass, true) !~ '\m(people|memberships|engagements|counterparties|organizations|projects)\M',
  'app.zone_presence has no join to people, memberships, engagements, counterparties, organizations or projects');
select ok(pg_catalog.pg_get_viewdef('app.muster_list'::regclass, true) !~ '\m(people|memberships|engagements|counterparties|organizations|projects)\M',
  'nor has app.muster_list');

-- Row level security ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select count(*)::int from app.zone_presence where project_id = pg_temp.id('prj_a2')), 0,
  'a Field member without credentials.scan_log.read on NWX sees no scan presence there');
select pg_temp.as_user('erin');
select is((select count(*)::int from app.zone_presence where source = 'Clock In'), 0,
  'a Collaborator without crew.time_entry.read sees no clock-in presence');
select ok((select count(*) from app.zone_presence where source = 'Scan') > 0, 'but sees the scans of a project they are assigned to');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.muster_list where source = 'Guest Check In'),
  (select count(*)::int from app.guest_list_entries where entry_state = 'Checked In'),
  'guest rows follow the guest list (advancing.packet.read), not the door check-ins');
select is((select count(*)::int from app.muster_list where door is not null or plus_ones is not null), 0,
  'and a Viewer without credentials.scan.write sees no door or plus-ones');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.muster_list), 0, 'another org sees nothing');
select lives_ok($$select * from app.zone_presence, app.zone_counts_live, app.muster_list$$,
  'and reads every column of the three views without a crash');
select pg_temp.as_user('victor');
select lives_ok($$select * from app.zone_presence, app.zone_counts_live, app.muster_list$$,
  'as does the owner of a party account');
select pg_temp.as_user('ivy');
select lives_ok($$select * from app.zone_presence, app.zone_counts_live, app.muster_list$$,
  'and an engaged person');
select pg_temp.as_user('nina');
select lives_ok($$select count(*) from (select * from app.muster_list union all select * from app.muster_list) x$$,
  'as does a person with no org');
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
