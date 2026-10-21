-- pgTAP: migration 1321, the Time and Attendance settings take effect where punches are recorded (A76, RRR-121,
-- A65-001). time.geofence_required refuses a phone clock-in without a location or outside the project venue's
-- geofence, and a person's own web clock-in while the geofence applies; kiosks and projects without a geofence are
-- exempt. time.photo_on_punch makes kiosk clock-ins and clock-outs carry a photo. time.rounding_minutes rounds the
-- entry's clock-in and clock-out while the punch keeps its exact time. time.kiosk_enabled keeps kiosks off until the
-- org or the project's workspace turns them on. Each setting is changed here and the behavior observed.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(23);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;
insert into k values ('ws_in', private.uuid_v7()), ('ws_out', private.uuid_v7()), ('kin', private.uuid_v7()), ('kout', private.uuid_v7()),
  ('kin2', private.uuid_v7()), ('kws', private.uuid_v7());

select pg_temp.as_platform();
insert into app.project_members (project_id, membership_id, project_role) values
  (pg_temp.id('prj_a2'), pg_temp.id('dave@org_a'), 'Coordinator'), (pg_temp.id('prj_a2'), pg_temp.id('frank@org_a'), 'Field'),
  (pg_temp.id('prj_a2'), pg_temp.id('carol@org_a'), 'Coordinator');
with x as (insert into app.geofences (venue_id, name, boundary) values (pg_temp.id('venue_a'), 'Pavilion Fence',
  'SRID=4326;POLYGON((-80.20 25.77, -80.19 25.77, -80.19 25.78, -80.20 25.78, -80.20 25.77))') returning id) insert into world select 'fence', id from x;

-- time.geofence_required ---------------------------------------------------------------------------------------------
select is(private.project_setting_boolean(pg_temp.id('prj_a'), 'time.geofence_required'), true, 'the geofence applies by default');
select pg_temp.as_user('frank');
select throws_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'In', now())$$,
  'XR001', 'punch_location_required: This project needs your location to clock in; clock in on site from Compass with location on.',
  'a phone clock-in without a location is refused while the venue has a geofence');
select throws_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'In', now(), null, null, 25.775, -80.10, 10)$$,
  'XR001', 'punch_outside_geofence: You are outside the project''s geofence; clock in on site.', 'a phone clock-in outside the geofence is refused');
select lives_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'In', now() - interval '1 hour', null, null, 25.775, -80.195, 10)$$,
  'a phone clock-in inside the geofence is recorded');
select lives_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'Out', now() - interval '30 minutes')$$,
  'a clock-out needs no location');
select pg_temp.as_user('dave');
select lives_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a2'), 'In', now() - interval '2 hours')$$,
  'a project whose venue has no geofence takes a clock-in without a location');
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a2'), 'Out', now() - interval '90 minutes');

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'time.geofence_required', 'Project', pg_temp.id('prj_a'), p_value_boolean => false);
select pg_temp.as_user('dave');
select lives_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'In', now() - interval '20 minutes')$$,
  'with the geofence turned off for the project, a clock-in without a location is recorded');
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'Out', now() - interval '10 minutes');
select pg_temp.as_user('alice');
select app.clear_setting(pg_temp.id('org_a'), 'time.geofence_required', 'Project', pg_temp.id('prj_a'));

-- Web clock-ins
select pg_temp.as_user('frank');
select throws_ok($$insert into app.time_entries (project_id, membership_id, clock_in, source)
  values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank@org_a'), now(), 'Web')$$,
  'XR001', null, 'a person''s own web clock-in is refused while the geofence applies, since the web carries no location');
select pg_temp.as_user('alice');
select lives_ok($$insert into app.time_entries (project_id, membership_id, clock_in, clock_out, source)
  values ((select id from world where key = 'prj_a'), (select id from world where key = 'erin@org_a'), now() - interval '30 hours', now() - interval '29 hours', 'Web')$$,
  'a supervisor''s manual entry for someone else is a correction and keeps going');

-- time.kiosk_enabled ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
create temporary table kiosk_key as select * from app.register_kiosk_device(pg_temp.id('org_a'), 'Pavilion Kiosk', pg_temp.id('prj_a'));
grant select on kiosk_key to public;
select app.set_kiosk_pin(pg_temp.id('erin@org_a'), '2468');
select pg_temp.as_platform();
select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('erin@org_a'), '2468', (select id from k where key = 'kin'), 'In', now())),
  'kiosk_disabled', 'kiosk punches are refused while kiosks are off (the default)');
select pg_temp.as_user('alice');
update app.projects set workspace_id = pg_temp.id('ws_a') where id = pg_temp.id('prj_a');
select app.set_setting(pg_temp.id('org_a'), 'time.kiosk_enabled', 'Workspace', pg_temp.id('ws_a'), p_value_boolean => true);
select pg_temp.as_platform();
select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('erin@org_a'), '2468', (select id from k where key = 'kws'), 'In', now() - interval '3 minutes')),
  null, 'turning kiosks on for the project''s workspace lets the kiosk punch, with no location (kiosks are exempt from the geofence)');
select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('erin@org_a'), '2468', private.uuid_v7(), 'Out', now() - interval '1 minute')),
  null, 'and clock out');

-- time.photo_on_punch ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'time.photo_on_punch', 'Organization', pg_temp.id('org_a'), p_value_boolean => true);
select pg_temp.as_platform();
select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('erin@org_a'), '2468', (select id from k where key = 'kin2'), 'In', now())),
  'punch_photo_required', 'with photo on punch, a kiosk clock-in without a photo is refused');
select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('erin@org_a'), '2468', (select id from k where key = 'kin2'), 'In', now(), null, 'storage://field-media/kiosk/erin-in.jpg')),
  null, 'a kiosk clock-in with a photo is recorded');
select is((select photo_uri from app.clock_punches where id = (select id from k where key = 'kin2')), 'storage://field-media/kiosk/erin-in.jpg', 'and keeps the photo');
select pg_temp.as_platform();
select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('erin@org_a'), '2468', private.uuid_v7(), 'Out', now() + interval '1 minute')),
  'punch_photo_required', 'so does a kiosk clock-out');
select pg_temp.as_user('dave');
select lives_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a2'), 'In', now() - interval '8 minutes')$$,
  'photo on punch asks kiosks, not a person''s own phone');
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a2'), 'Out', now() - interval '6 minutes');

-- time.rounding_minutes ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'time.rounding_minutes', 'Project', pg_temp.id('prj_a2'), p_value_text => '15');
select pg_temp.as_user('carol');
select app.record_punch((select id from k where key = 'ws_in'), pg_temp.id('prj_a2'), 'In',
  date_trunc('hour', now() - interval '6 hours') + interval '7 minutes 10 seconds');
select app.record_punch((select id from k where key = 'ws_out'), pg_temp.id('prj_a2'), 'Out',
  date_trunc('hour', now() - interval '6 hours') + interval '1 hour 53 minutes');
select pg_temp.as_platform();
select is((select t.clock_in from app.time_entries t join app.clock_punches c on c.time_entry_id = t.id where c.id = (select id from k where key = 'ws_in')),
  date_trunc('hour', now() - interval '6 hours'), 'a 15-minute rule rounds the clock-in to the nearest quarter hour');
select is((select t.clock_out from app.time_entries t join app.clock_punches c on c.time_entry_id = t.id where c.id = (select id from k where key = 'ws_out')),
  date_trunc('hour', now() - interval '6 hours') + interval '2 hours', 'and the clock-out');
select is((select effective_at from app.clock_punches where id = (select id from k where key = 'ws_in')),
  date_trunc('hour', now() - interval '6 hours') + interval '7 minutes 10 seconds', 'the punch keeps its exact time');
select is(private.round_punch_time('2027-06-04 09:03:00+00', 6), '2027-06-04 09:06:00+00'::timestamptz, 'a 6-minute rule rounds to the tenth of an hour');
select is(private.round_punch_time('2027-06-04 09:03:00+00', 0), '2027-06-04 09:03:00+00'::timestamptz, '0 keeps the exact time');

-- Web clock-in rounding: a person's own web clock-in on a project with no geofence.
create temporary table web_at as select now() - interval '10 minutes' as at;
grant select on web_at to public;
select pg_temp.as_user('frank');
insert into app.time_entries (project_id, membership_id, clock_in, source)
values (pg_temp.id('prj_a2'), pg_temp.id('frank@org_a'), (select at from web_at), 'Web');
select pg_temp.as_platform();
select is((select clock_in from app.time_entries where membership_id = pg_temp.id('frank@org_a') and clock_out is null and source = 'Web'),
  to_timestamp(round(extract(epoch from (select at from web_at)) / 900) * 900), 'a person''s own web clock-in rounds too');

select * from finish();
rollback;
