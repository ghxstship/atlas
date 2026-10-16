-- pgTAP: A09 geofence writes from GeoJSON and the zone space venue guard (migration 0422).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(10);

select pg_temp.as_user('alice');
select lives_ok($$insert into world values ('fence', app.save_geofence(null, (select id from world where key = 'venue_a'), null, 'Pier Fence',
  '{"type":"Polygon","coordinates":[[[-80.19,25.77],[-80.18,25.77],[-80.18,25.78],[-80.19,25.78],[-80.19,25.77]]]}'::jsonb))$$,
  'an Owner saves a geofence from a GeoJSON Polygon');
select is((select boundary_geojson ->> 'type' from app.geofence_shapes where id = pg_temp.id('fence')), 'Polygon', 'the boundary reads back as GeoJSON');
select throws_ok($$select app.save_geofence(null, (select id from world where key = 'venue_a'), null, 'Bad', '{"type":"Point","coordinates":[-80.19,25.77]}'::jsonb)$$,
  'XR001', 'geofence_polygon: A geofence boundary is a GeoJSON Polygon in WGS 84.', 'a boundary that is not a polygon is refused');
select throws_ok($$select app.save_geofence(null, (select id from world where key = 'venue_a'), null, 'Bad', '{"type":"Polygon","coordinates":"nope"}'::jsonb)$$,
  'XR001', 'geofence_polygon: A geofence boundary is a GeoJSON Polygon in WGS 84.', 'a malformed polygon is refused');
select lives_ok($$select app.save_geofence((select id from world where key = 'fence'), null, null, 'Pier Fence North',
  '{"type":"Polygon","coordinates":[[[-80.19,25.77],[-80.17,25.77],[-80.17,25.79],[-80.19,25.79],[-80.19,25.77]]]}'::jsonb)$$, 'an Owner edits it');
select is((select name from app.geofences where id = pg_temp.id('fence')), 'Pier Fence North', 'the edit is saved');
select pg_temp.as_user('gina');
select throws_ok($$select app.save_geofence(null, (select id from world where key = 'venue_a'), null, 'Viewer Fence',
  '{"type":"Polygon","coordinates":[[[-80.19,25.77],[-80.18,25.77],[-80.18,25.78],[-80.19,25.77]]]}'::jsonb)$$, '42501', null, 'a Viewer cannot save a geofence');
select pg_temp.as_user('xavier');
select throws_ok($$select app.save_geofence((select id from world where key = 'fence'), null, null, 'Taken',
  '{"type":"Polygon","coordinates":[[[-80.19,25.77],[-80.18,25.77],[-80.18,25.78],[-80.19,25.77]]]}'::jsonb)$$, '42501', null, 'another org cannot edit it');

select pg_temp.as_user('alice');
with x as (insert into app.spaces (venue_id, name) values (pg_temp.id('venue_a'), 'Main Deck') returning id) insert into world select 'space_a', id from x;
select lives_ok($$insert into app.zones (venue_id, space_id, code, name) values ((select id from world where key = 'venue_a'), (select id from world where key = 'space_a'), 'FOH', 'Front of House')$$,
  'a zone sits in a space of its own venue');
select pg_temp.as_platform();
with x as (insert into app.venues (org_id, name, jurisdiction_id, time_zone) values (pg_temp.id('org_a'), 'Second Hall', 'US', 'UTC') returning id) insert into world select 'venue_a2', id from x;
select throws_ok($$insert into app.zones (venue_id, space_id, code, name) values ((select id from world where key = 'venue_a2'), (select id from world where key = 'space_a'), 'X', 'Cross')$$,
  'XR001', 'zone_space_venue: A zone sits in a space of its own venue.', 'a zone cannot sit in another venue''s space');

select * from finish();
rollback;
