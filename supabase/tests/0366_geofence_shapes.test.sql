-- pgTAP: geofence shapes as GeoJSON (requested by A17), visible exactly as geofences are.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(7);

select pg_temp.as_platform();
with x as (insert into app.geofences (venue_id, name, boundary) values (pg_temp.id('venue_a'), 'Pavilion Fence',
  'SRID=4326;POLYGON((-80.20 25.77, -80.19 25.77, -80.19 25.78, -80.20 25.78, -80.20 25.77))') returning id) insert into world select 'fence', id from x;
with x as (insert into app.geofences (venue_id, name, boundary) values (pg_temp.id('venue_b'), 'Dock Fence',
  'SRID=4326;POLYGON((-80.10 25.70, -80.09 25.70, -80.09 25.71, -80.10 25.71, -80.10 25.70))') returning id) insert into world select 'fence_b', id from x;

select pg_temp.as_user('dave');
select is((select boundary_geojson ->> 'type' from app.geofence_shapes where id = pg_temp.id('fence')), 'Polygon', 'the outline is a GeoJSON Polygon');
select is((select jsonb_array_length(boundary_geojson -> 'coordinates' -> 0) from app.geofence_shapes where id = pg_temp.id('fence')), 5, 'with its closed ring of points');
select is((select (boundary_geojson -> 'coordinates' -> 0 -> 0 ->> 0)::numeric from app.geofence_shapes where id = pg_temp.id('fence')), -80.20, 'longitude first, as GeoJSON orders it');
select set_eq('select id from app.geofence_shapes', 'select id from app.geofences', 'shapes are visible exactly as geofences are');
select is((select count(*)::int from app.geofence_shapes where id = pg_temp.id('fence_b')), 0, 'another org''s geofence stays hidden');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.geofence_shapes where id = pg_temp.id('fence')), 0, 'and the other way round');
select pg_temp.as_anon();
select throws_ok('select 1 from app.geofence_shapes', '42501', null, 'anon cannot read geofence shapes');
select pg_temp.as_platform();

select * from finish();
rollback;
