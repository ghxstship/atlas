-- pgTAP: geofence shapes carry their org (A39), so Compass's device-side scope check keeps them.
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

select has_column('app', 'geofence_shapes', 'org_id', 'geofence shapes have an org_id column');
select is(
  (select array_agg(attname::text order by attnum) from pg_attribute
   where attrelid = 'app.geofence_shapes'::regclass and attnum > 0 and not attisdropped),
  array['id', 'venue_id', 'zone_id', 'name', 'boundary_geojson', 'org_id'],
  'the earlier columns keep their order, org_id comes last');

select pg_temp.as_user('dave');
select is((select org_id from app.geofence_shapes where id = pg_temp.id('fence')), pg_temp.id('org_a'),
  'a member reads the org that owns the geofence');
select is((select count(*)::int from app.geofence_shapes where id = pg_temp.id('fence_b')), 0,
  'another org''s geofence stays hidden');
select set_eq('select id, org_id from app.geofence_shapes', 'select id, org_id from app.geofences',
  'shapes and their orgs are visible exactly as geofences are');

select pg_temp.as_platform();
update app.geofences set deleted_at = now() where id = pg_temp.id('fence');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.geofence_shapes where id = pg_temp.id('fence')), 0,
  'a deleted geofence leaves the view');

select pg_temp.as_anon();
select throws_ok('select org_id from app.geofence_shapes', '42501', null, 'anon cannot read geofence shapes');
select pg_temp.as_platform();

select * from finish();
rollback;
