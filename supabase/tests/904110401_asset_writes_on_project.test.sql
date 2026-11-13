-- pgTAP: migration 904110401, the asset custody and damage writes in the project capability read. A Field lead and a
-- Member assigned to the project are answered both writes there, which is what Atlas's unit peek now offers them; on a
-- project they are not assigned to, and for a Viewer, the answer is empty. Maintenance stays out of the read (its
-- policies take it org-wide only), and the reads answered before are answered as before. A Field lead's damage report
-- on their project is taken when it reads nothing back, as reportAssetDamage now inserts it, while reading it back
-- (RETURNING) is refused, since reading damage takes assets.asset.read org-wide.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(10);

select pg_temp.as_user('alice');
with c as (insert into app.asset_classes (org_id, element_id, name)
           values (pg_temp.id('org_a'), '8000.01.01-XPMS-001', 'Radios') returning id)
insert into world select 'cls_radio', id from c;
with u as (insert into app.asset_units (asset_class_id, asset_tag, home_venue_id)
           values (pg_temp.id('cls_radio'), 'NWL-RAD-001', pg_temp.id('venue_a')) returning id)
insert into world select 'unit_r1', id from u;

select pg_temp.as_user('frank');
select is(app.my_capabilities_on_project(pg_temp.id('prj_a'), array['assets.custody.write', 'assets.damage.write']),
  array['assets.custody.write', 'assets.damage.write'],
  'a Field lead assigned to the project is answered the custody and damage writes there');
select is(app.my_capabilities_on_project(pg_temp.id('prj_a2'), array['assets.custody.write', 'assets.damage.write']),
  '{}'::text[], 'and not on a project they are not assigned to');
select is(app.my_capabilities_on_project(pg_temp.id('prj_a'), array['assets.maintenance.write', 'assets.asset.write']),
  '{}'::text[], 'maintenance and edits stay out of the read, as their policies take them org-wide only');
select ok(not exists (select 1 from app.asset_damage), 'the Field lead reads no damage (assets.asset.read is assigned)');
select lives_ok(
  format($$insert into app.asset_damage (org_id, asset_unit_id, project_id, description) values ('%s', '%s', '%s', 'Bent antenna.')$$,
    pg_temp.id('org_a'), pg_temp.id('unit_r1'), pg_temp.id('prj_a')),
  'a damage report on their project that reads nothing back is taken');
select throws_ok(
  format($$insert into app.asset_damage (org_id, asset_unit_id, project_id, description) values ('%s', '%s', '%s', 'Cracked case.') returning id$$,
    pg_temp.id('org_a'), pg_temp.id('unit_r1'), pg_temp.id('prj_a')),
  '42501', null, 'while reading it back is refused');

select pg_temp.as_user('dave');
select is(app.my_capabilities_on_project(pg_temp.id('prj_a'), array['assets.custody.write', 'assets.damage.write']),
  array['assets.custody.write', 'assets.damage.write'], 'a Member assigned to the project is answered both');

select pg_temp.as_user('gina');
select is(app.my_capabilities_on_project(pg_temp.id('prj_a'), array['assets.custody.write', 'assets.damage.write']),
  '{}'::text[], 'a Viewer is answered neither');

select pg_temp.as_user('alice');
select is(app.my_capabilities_on_project(pg_temp.id('prj_a'), array['finance.budget.read', 'assets.custody.write', 'org.members.manage']),
  array['assets.custody.write', 'finance.budget.read'], 'the reads answered before are answered as before, and others still are not');
select pg_temp.as_platform();
select is((select count(*)::int from app.asset_damage where asset_unit_id = pg_temp.id('unit_r1')), 1,
  'the one report the Field lead made is recorded');

select * from finish();
rollback;
