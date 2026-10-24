-- pgTAP: migration 1612's emergency codes as Compass reads them (WP18, Section 4.3 item 13, Reference offline).
-- Compass downloads app.emergency_codes through row level security, so a member's device holds their org's live
-- codes and nobody else's; a person the org engages without a membership reads none and sees the canon codes,
-- which every signed-in person reads. Only safety.emergency_code.write edits a copy.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(10);

-- Each org of the world holds its copy (app.create_organization copies it); org_a relabels one code and removes
-- another.
select pg_temp.as_platform();
update app.emergency_codes set label = 'Fire Alarm', sort_order = 20
where org_id = pg_temp.id('org_a') and code = 'CODE_RED';
update app.emergency_codes set deleted_at = now() where org_id = pg_temp.id('org_a') and code = 'CODE_BLUE';

select pg_temp.as_user('dave');
select is((select count(*)::int from app.emergency_codes where deleted_at is null), 13,
  'a member reads their org''s live codes, the removed one aside');
select is((select label from app.emergency_codes where code = 'CODE_RED'), 'Fire Alarm', 'with the org''s own label');
select is((select count(*)::int from app.emergency_codes where org_id <> pg_temp.id('org_a')), 0,
  'and no other org''s codes');

select pg_temp.as_user('xavier');
select is((select count(*)::int from app.emergency_codes where org_id = pg_temp.id('org_a')), 0,
  'a member of another org reads none of them');
select is((select count(*)::int from app.emergency_codes where deleted_at is null), 14, 'only their own org''s copy');

select pg_temp.as_user('ivy');
select is((select count(*)::int from app.emergency_codes), 0,
  'a person the org engages without a membership reads none, so Compass shows them the canon codes');
select is((select count(*)::int from xpms.emergency_code), 14, 'every signed-in person reads the canon codes');

select is(has_table_privilege('anon', 'app.emergency_codes', 'select'), false, 'nobody signed out reads them');

-- A Field member reads the codes but cannot change them.
select pg_temp.as_user('frank');
update app.emergency_codes set label = 'Changed in the field' where code = 'CODE_ORANGE';
select pg_temp.as_platform();
select isnt((select label from app.emergency_codes where org_id = pg_temp.id('org_a') and code = 'CODE_ORANGE'),
  'Changed in the field', 'a member without safety.emergency_code.write cannot relabel a code');

select pg_temp.as_user('alice');
update app.emergency_codes set label = 'Hazmat' where code = 'CODE_ORANGE';
select pg_temp.as_platform();
select is((select label from app.emergency_codes where org_id = pg_temp.id('org_a') and code = 'CODE_ORANGE'),
  'Hazmat', 'the Owner relabels it, and the next download carries the new label');

select * from finish();
rollback;
