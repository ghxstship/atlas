-- pgTAP: A14 field path (migration 0470). app.record_scan by id and by printed number, idempotent
-- replay, refused replays by another person, unknown codes, scan.write on the project, cross-tenant
-- and anon denial; device time and offline decision on scans; incident location and device time;
-- project copies kept by the database; module
-- capabilities on a project; dispatch, all-clear and denied-scan events.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(37);

-- Fixture: a zone, a category with a grid row, a credential for frank --------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'FOH', 'Front of House') returning id) insert into world select 'zone', id from x;
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'STG', 'Stage') returning id) insert into world select 'zone_stage', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id) insert into world select 'cat', id from x;
with x as (insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
  values (pg_temp.id('cat'), pg_temp.id('zone'), 'ENM-036', now() - interval '1 day', now() + interval '1 day') returning id) insert into world select 'grid', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('frank')) returning id) insert into world select 'cred', id from x;

-- Project copies ------------------------------------------------------------------------------------------------
select is((select project_id from app.credentials where id = pg_temp.id('cred')), pg_temp.id('prj_a'), 'a credential carries its category''s project');
select is((select project_id from app.access_grid where id = pg_temp.id('grid')), pg_temp.id('prj_a'), 'a grid row carries its category''s project');
select throws_ok($$update app.credentials set project_id = (select id from world where key = 'prj_a2') where id = (select id from world where key = 'cred')$$,
  'XR001', 'project_copy_immutable: A row keeps the project of its parent.', 'the project copy is never written by the caller');
select lives_ok($$insert into app.credentials (credential_category_id, holder_person_id, project_id) values ((select id from world where key = 'cat'), (select id from world where key = 'dave'), (select id from world where key = 'prj_a2'))$$,
  'a caller-sent project is ignored on insert');
select is((select project_id from app.credentials where holder_person_id = pg_temp.id('dave')), pg_temp.id('prj_a'), 'and replaced by the category''s project');

-- record_scan -------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select result::text from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred'))), 'Granted', 'a Field member assigned to the project scans a credential the grid allows');
select is((select result::text from app.record_scan(pg_temp.id('zone_stage'), pg_temp.id('cred'))), 'Denied', 'a zone missing from the grid is denied');
select is((select holder_name from app.record_scan(pg_temp.id('zone'), null, (select lower(credential_number) from app.credentials where id = pg_temp.id('cred'))
  )), 'Frank Adeyemi', 'a scan by printed number, in any case, finds the credential and names the holder');
select is((select project_id from app.access_scans order by scanned_at desc, id desc limit 1), pg_temp.id('prj_a'), 'a scan carries the credential''s project');
select is((select replayed from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred'), null, '01920000-0000-7000-8000-00000000a001'::uuid, now() - interval '1 hour', 'Granted')),
  false, 'a scan with a client id is stored');
select is((select replayed from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred'), null, '01920000-0000-7000-8000-00000000a001'::uuid, now() - interval '1 hour', 'Granted')),
  true, 'replaying the same client id returns the stored scan');
select is((select count(*)::int from app.access_scans where id = '01920000-0000-7000-8000-00000000a001'), 1, 'and stores nothing new');
select is((select offline_result::text from app.access_scans where id = '01920000-0000-7000-8000-00000000a001'), 'Granted', 'the offline decision is kept');
select ok((select device_scanned_at < scanned_at from app.access_scans where id = '01920000-0000-7000-8000-00000000a001'), 'the device time is kept beside the server time');
select throws_ok($$select * from app.record_scan((select id from world where key = 'zone'), null, 'CR-999999')$$,
  'XR001', 'credential_unknown: No credential of this organization matches the scanned code.', 'an unknown code is refused');
select throws_ok($$select * from app.record_scan((select id from world where key = 'zone'), (select id from world where key = 'cred'), null, null, now() + interval '1 hour')$$,
  'XR001', 'scan_device_time_future: A scan''s device time cannot be later than the server time.', 'a device time in the future is refused');
select throws_ok($$select * from app.record_scan((select id from world where key = 'zone'), (select id from world where key = 'cred'), null, null, null, 'Denied')$$,
  'XR001', 'scan_offline_needs_time: An offline decision is recorded with the device time it was made.', 'an offline decision needs its device time');
select pg_temp.as_user('carol');
select throws_ok($$select * from app.record_scan((select id from world where key = 'zone'), (select id from world where key = 'cred'), null, '01920000-0000-7000-8000-00000000a001'::uuid)$$,
  'XR001', 'scan_id_taken: Another scan already uses this id.', 'another person cannot replay a scan id');
select pg_temp.as_user('gina');
select throws_ok($$select * from app.record_scan((select id from world where key = 'zone'), (select id from world where key = 'cred'))$$,
  '42501', null, 'a Viewer cannot scan');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.record_scan((select id from world where key = 'zone'), (select id from world where key = 'cred'))$$,
  '42501', null, 'another org cannot scan this org''s credentials');
select pg_temp.as_anon();
select throws_ok($$select * from app.record_scan((select id from world where key = 'zone'), (select id from world where key = 'cred'))$$,
  '42501', null, 'anon cannot scan');
select pg_temp.as_platform();
select ok((select count(*) from app.domain_events where event_type = 'access_scan.denied') >= 1, 'a denied scan emits access_scan.denied');

-- Incidents: location and device time ----------------------------------------------------------------------------
select pg_temp.as_user('frank');
with x as (insert into app.incidents (project_id, title, severity_enum_id, occurred_at, latitude, longitude, accuracy_m, device_reported_at)
  values (pg_temp.id('prj_a'), 'Guest Fall Near Gate 2', 'ENM-099', now() - interval '10 minutes', 25.800100, -80.199900, 12.5, now() - interval '9 minutes') returning id)
  insert into world select 'inc', id from x;
select is((select latitude from app.incidents where id = pg_temp.id('inc')), 25.800100::numeric(9, 6), 'a Field member files an incident with a location');
select throws_ok($$insert into app.incidents (project_id, title, severity_enum_id, occurred_at, latitude) values ((select id from world where key = 'prj_a'), 'Half', 'ENM-099', now(), 25.8)$$,
  '23514', null, 'a location has both coordinates');
select throws_ok($$insert into app.incidents (project_id, title, severity_enum_id, occurred_at, latitude, longitude) values ((select id from world where key = 'prj_a'), 'North', 'ENM-099', now(), 91, 0)$$,
  '23514', null, 'a latitude stays within range');
select throws_ok($$insert into app.incidents (project_id, title, severity_enum_id, occurred_at, device_reported_at) values ((select id from world where key = 'prj_a'), 'Later', 'ENM-099', now(), now() + interval '1 hour')$$,
  'XR001', 'incident_device_time_future: An incident''s device time cannot be later than the server time.', 'a device report time in the future is refused');
select throws_ok($$update app.incidents set device_reported_at = now() - interval '1 day' where id = (select id from world where key = 'inc')$$,
  'XR001', 'incident_device_time_immutable: An incident keeps the device time it was reported at.', 'the device report time never changes');
insert into app.incident_media (incident_id, media_uri) values (pg_temp.id('inc'), 'incidents/gate-2-fall.jpg');
select is((select project_id from app.incident_media where incident_id = pg_temp.id('inc')), pg_temp.id('prj_a'), 'incident media carries the incident''s project');

-- Dispatch and crisis events (dispatch is the manager band's and the Field Supervisor's since 1110) -----------------
select pg_temp.as_user('carol');
select lives_ok($$insert into app.dispatch_assignments (incident_id, membership_id) values ((select id from world where key = 'inc'), (select id from world where key = 'frank@org_a'))$$,
  'a Manager with dispatch reach dispatches a responder');
update app.dispatch_assignments set arrived_at = now() where incident_id = pg_temp.id('inc');
with x as (insert into app.crisis_alerts (project_id, emergency_code, message) values (pg_temp.id('prj_a'), 'CODE_RED', 'Fire reported at the north gate. Evacuate the north lawn.') returning id) insert into world select 'alert', id from x;
update app.crisis_alerts set ended_at = now() where id = pg_temp.id('alert');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'dispatch.assigned' and subject_id = pg_temp.id('inc')), 1, 'dispatching emits dispatch.assigned on the incident');
select is((select count(*)::int from app.domain_events where event_type = 'dispatch.arrived' and subject_id = pg_temp.id('inc')), 1, 'arrival emits dispatch.arrived');
select is((select project_id from app.domain_events where event_type = 'dispatch.arrived' and subject_id = pg_temp.id('inc')), pg_temp.id('prj_a'), 'with the incident''s project');
select is((select count(*)::int from app.domain_events where event_type = 'crisis_alert.ended' and subject_id = pg_temp.id('alert')), 1, 'the all-clear emits crisis_alert.ended');

-- Capabilities on a project ------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select ok('credentials.credential.issue' = any (app.my_capabilities_on_project(pg_temp.id('prj_a'), array['credentials.credential.issue', 'safety.incident.close'])),
  'a Member assigned to the project holds issue there');
select is(app.my_capabilities_on_project(pg_temp.id('prj_a2'), array['credentials.credential.issue']), '{}'::text[], 'but not on a project they are not assigned to');
select is(app.my_capabilities_on_project(pg_temp.id('prj_a'), array['org.members.manage']), '{}'::text[], 'only module capabilities are answered');
select pg_temp.as_user('xavier');
select is(app.my_capabilities_on_project(pg_temp.id('prj_a'), array['credentials.credential.read']), '{}'::text[], 'another org holds nothing on the project');
select pg_temp.as_platform();

select * from finish();
rollback;
