-- pgTAP: app.my_projects_with_capabilities (crawl 4.9). For each live project of an org, which of the named module
-- capabilities the signed-in person may use there, by private.project_ids_with: a Field member on prj_a reports there
-- only, a Manager dispatches on every project, a capability outside the module list is never answered, another org's
-- projects never show, and anon cannot call it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(8);

select pg_temp.as_user('frank');
select results_eq(
  $$select project_id, capability_code from app.my_projects_with_capabilities((select id from world where key = 'org_a'),
    array['safety.incident.write', 'safety.incident.dispatch'])$$,
  $$values ((select id from world where key = 'prj_a'), 'safety.incident.write')$$,
  'a Field member reports on the project he is on, and dispatches nowhere');
select is((select count(*)::int from app.my_projects_with_capabilities(pg_temp.id('org_a'), array['safety.incident.write']) x
  where x.project_id = pg_temp.id('prj_a2')), 0, 'not on a project he is not a member of');
select is((select count(*)::int from app.my_projects_with_capabilities(pg_temp.id('org_b'), array['safety.incident.write'])), 0,
  'another org''s projects never show');

select pg_temp.as_user('carol');
select results_eq(
  $$select project_id from app.my_projects_with_capabilities((select id from world where key = 'org_a'),
    array['safety.incident.dispatch']) order by project_id$$,
  $$select id from world where key in ('prj_a', 'prj_a2') order by id$$,
  'a Manager dispatches on every project of the org');
select is((select count(*)::int from app.my_projects_with_capabilities(pg_temp.id('org_a'),
  array['safety.incident.dispatch', 'safety.incident.dispatch'])), 2, 'a capability named twice is answered once per project');
select is((select count(*)::int from app.my_projects_with_capabilities(pg_temp.id('org_a'), array['org.settings.write'])), 0,
  'a capability outside the module list is never answered');
select pg_temp.claims('carol');
select is(
  (select count(*)::int from app.my_projects_with_capabilities(pg_temp.id('org_a'), array['safety.incident.dispatch']) x
   where not private.can_on_project(x.project_id, x.capability_code)), 0,
  'every pair agrees with private.can_on_project');

select pg_temp.as_anon();
select throws_ok($$select * from app.my_projects_with_capabilities((select id from world where key = 'org_a'), array['safety.incident.write'])$$,
  '42501', null, 'anon cannot call it');

select * from finish();
rollback;
