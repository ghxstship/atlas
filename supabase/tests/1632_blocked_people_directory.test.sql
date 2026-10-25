-- pgTAP: migration 1632, the workforce directory under a person block (ADR 0033 decision 57). Frank and Dave share
-- their preferred name and headline with their network. Once Dave blocks Frank, each still finds the other in the
-- directory by name, but without the preferred name and headline, and a search no longer matches on them; Erin, who
-- blocked nobody, sees both. Lifting the block shows them again.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(10);

select pg_temp.as_user('frank');
insert into app.person_profiles (person_id, handle, preferred_name, headline, visibility)
values (pg_temp.id('frank'), 'frank-rigs', 'Frankie', 'Head rigger, loves a long load-out', 'Network');
select pg_temp.as_user('dave');
insert into app.person_profiles (person_id, handle, preferred_name, headline, visibility)
values (pg_temp.id('dave'), 'dave-coordinates', 'Davey', 'Coordinator on the main stage', 'Network');

select is((select preferred_name || ' / ' || headline from app.workforce_directory(pg_temp.id('org_a'), 'frank')),
  'Frankie / Head rigger, loves a long load-out', 'before: Dave reads Frank''s preferred name and headline');

select app.block_member(pg_temp.id('frank@org_a'));

select is((select count(*)::int from app.workforce_directory(pg_temp.id('org_a'), 'frank')), 1,
  'after the block Dave still finds Frank by name');
select is((select row(preferred_name, headline, photo_path)::text from app.workforce_directory(pg_temp.id('org_a'), 'frank')),
  row(null::text, null::text, null::text)::text, 'but without his preferred name, headline or photo');
select is((select count(*)::int from app.workforce_directory(pg_temp.id('org_a'), 'Frankie')), 0,
  'and a search for his preferred name no longer finds him');

select pg_temp.as_user('frank');
select is((select row(preferred_name, headline)::text from app.workforce_directory(pg_temp.id('org_a'), 'dave')),
  row(null::text, null::text)::text, 'Frank no longer reads Dave''s preferred name or headline either');
select is((select count(*)::int from app.workforce_directory(pg_temp.id('org_a'), 'main stage')), 0,
  'nor finds him by his headline');

select pg_temp.as_user('erin');
select is((select preferred_name from app.workforce_directory(pg_temp.id('org_a'), 'frank')), 'Frankie',
  'Erin, who blocked nobody, still reads Frank''s preferred name');
select is((select preferred_name from app.workforce_directory(pg_temp.id('org_a'), 'main stage')), 'Davey',
  'and finds Dave by his headline');

select pg_temp.as_user('dave');
update app.blocks set deleted_at = now() where blocked_person_id = pg_temp.id('frank');
select is((select preferred_name || ' / ' || headline from app.workforce_directory(pg_temp.id('org_a'), 'Frankie')),
  'Frankie / Head rigger, loves a long load-out', 'lifting the block shows Frank''s profile basics again');
select is((select count(*)::int from app.workforce_directory(pg_temp.id('org_a'))), 8, 'and the directory still lists every member');

select * from finish();
rollback;
