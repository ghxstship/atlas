-- pgTAP: 1500, app.my_org_brands gives Compass the brand of every org the signed-in person works in
-- (A93, RRR-138; Section 12 Mobile, Section 4.5.7 org switching).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(11);

select has_function('app', 'my_org_brands', array[]::text[], 'app.my_org_brands exists');
select isnt(obj_description('app.my_org_brands()'::regprocedure, 'pg_proc'), null, 'app.my_org_brands is documented');
select ok(not has_function_privilege('anon', 'app.my_org_brands()', 'execute'), 'anon cannot read brands through it');
select ok(has_function_privilege('authenticated', 'app.my_org_brands()', 'execute'), 'a signed-in person can');

-- Northwind (org_a) sets a brand; Harbor Lights (org_b) has none and reads as its org name.
select pg_temp.as_platform();
insert into app.org_brands (org_id, display_name, accent_hex, logo_light_path)
values (pg_temp.id('org_a'), 'Northwind Live', '#0B6E4F', pg_temp.id('org_a')::text || '/logo-light.png');

-- ivy is engaged by both orgs and a member of neither.
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.my_org_brands()), 2, 'an engaged person reads the brand of each org that engages them');
select is((select accent_hex from app.my_org_brands() where org_id = pg_temp.id('org_a')), '#0B6E4F',
  'the brand accent comes through');
select is((select name from app.my_org_brands() where org_id = pg_temp.id('org_a')), 'Northwind Live',
  'the brand name replaces the org name');
select is((select accent_hex from app.my_org_brands() where org_id = pg_temp.id('org_b')), null,
  'an org without a brand falls back to the platform accent (null)');

-- mia is a member of org_a and engaged by org_b.
select pg_temp.as_user('mia');
select is((select count(*)::int from app.my_org_brands() where org_id in (pg_temp.id('org_a'), pg_temp.id('org_b'))), 2,
  'a member engaged by another org reads both brands');

-- quinn is engaged by org_b only; alice is a member of org_a only.
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.my_org_brands() where org_id = pg_temp.id('org_a')), 0,
  'no brand of an org the person has no part in');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.my_org_brands() where org_id = pg_temp.id('org_b')), 0,
  'a member of one org never reads another org''s brand');
select pg_temp.as_platform();

select * from finish();
rollback;
