-- pgTAP: a Field member sees the zones their project's access grid names, at any venue (A39).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(7);

-- A second venue the project uses: one zone on prj_a's access grid, one not.
select pg_temp.as_user('carol');
with x as (insert into app.venues (org_id, name, jurisdiction_id, time_zone)
  values (pg_temp.id('org_a'), 'Northwind Festival Grounds', 'US-FL-MIAMI-DADE', 'America/New_York') returning id)
  insert into world select 'venue_c', id from x;
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_c'), 'GATE', 'Festival Gate') returning id)
  insert into world select 'zone_grid', id from x;
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_c'), 'OFF', 'Production Office') returning id)
  insert into world select 'zone_off', id from x;
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'BOH', 'Back of House') returning id)
  insert into world select 'zone_home', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id)
  insert into world select 'cat', id from x;
insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
values (pg_temp.id('cat'), pg_temp.id('zone_grid'), 'ENM-036', now() - interval '1 day', now() + interval '1 day');

-- frank is a Field member of prj_a, whose venue is venue_a; Field reads places only where assigned.
select pg_temp.as_user('frank');
select is((select count(*)::int from app.zones where id = pg_temp.id('zone_home')), 1,
  'a Field member sees the zones of the project''s own venue, as before');
select is((select count(*)::int from app.zones where id = pg_temp.id('zone_grid')), 1,
  'and a zone at another venue that the project''s access grid names, so the gate scanner can pick it');
select is((select count(*)::int from app.zones where id = pg_temp.id('zone_off')), 0,
  'but not the other zones of that venue');

-- Removing the grid row takes the zone away again.
select pg_temp.as_user('carol');
update app.access_grid set deleted_at = now() where zone_id = pg_temp.id('zone_grid');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.zones where id = pg_temp.id('zone_grid')), 0,
  'a deleted access grid row no longer reveals its zone');

-- Other orgs and anon see none of it.
select pg_temp.as_user('carol');
update app.access_grid set deleted_at = null where zone_id = pg_temp.id('zone_grid');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.zones where id in (pg_temp.id('zone_grid'), pg_temp.id('zone_home'))), 0,
  'another org sees neither zone');
select pg_temp.as_anon();
select throws_ok('select 1 from app.zones', '42501', null, 'anon cannot read zones');
select pg_temp.as_platform();
select is(
  (select prosecdef from pg_proc where oid = 'private.zone_on_readable_access_grid(uuid)'::regprocedure),
  true, 'the helper runs as definer and takes the zone id as its argument (ADR 0016 item 14)');

select * from finish();
rollback;
