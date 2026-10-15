-- pgTAP: A07 activity feed entry (late slot 0951). One entry by id under the same feed rule, with
-- the catalog description of its event type.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(5);

select pg_temp.as_user('alice');
update app.projects set name = 'Northwind Summer Series 2027' where id = pg_temp.id('prj_a');
insert into world
select 'entry', f.id from app.activity_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'), null, 200) f
where f.event_type = 'project.updated';

select is((select count(*)::int from app.activity_feed(pg_temp.id('org_a'), null, null, 50, pg_temp.id('entry'))), 1,
  'one entry is read by id');
select is((select description from app.activity_feed(pg_temp.id('org_a'), null, null, 50, pg_temp.id('entry'))),
  (select description from app.domain_event_catalog where code = 'project.updated'),
  'the entry carries its event type''s catalog description');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.activity_feed(pg_temp.id('org_a'), null, null, 50, pg_temp.id('entry'))), 0,
  'a Viewer outside the project cannot read the entry by id (invariant 2)');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.activity_feed(pg_temp.id('org_a'), null, null, 50, pg_temp.id('entry'))), 1,
  'a member of the project reads it');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.activity_feed((select id from world where key = 'org_a'), null, null, 50,
  (select id from world where key = 'entry'))$$, '42501', null, 'another org cannot read it');
select pg_temp.as_platform();

select * from finish();
rollback;
