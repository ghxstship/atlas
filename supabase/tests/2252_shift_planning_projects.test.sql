-- pgTAP: migration 2252, the projects a planner may staff (A132, RRR-194, ADR 0063).
-- An org-wide planner gets every live project of the org; a person who holds crew.shift.write on one project only
-- (here through a project role) gets that project; a viewer and another org get none; anon cannot call it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(7);

select pg_temp.as_user('carol');
select ok((select count(*) from app.my_shift_planning_projects((select id from world where key = 'org_a'))) >= 2, 'the org has projects to plan');
select results_eq($$select project_id from app.my_shift_planning_projects((select id from world where key = 'org_a'))$$,
  $$select id from app.projects where org_id = (select id from world where key = 'org_a') and deleted_at is null order by id$$,
  'a manager (crew.shift.write across the org) plans on every project of the org');

-- dave is a Coordinator on prj_a only; let that project role add crew.shift.write for this suite.
select pg_temp.as_platform();
insert into private.project_role_capabilities (project_role, capability_code) values ('Coordinator', 'crew.shift.write');
select pg_temp.as_user('dave');
select results_eq($$select project_id from app.my_shift_planning_projects((select id from world where key = 'org_a'))$$,
  $$values ((select id from world where key = 'prj_a'))$$,
  'a person with crew.shift.write on one project plans on that project only');
select ok(not exists (select 1 from app.my_shift_planning_projects((select id from world where key = 'org_a')) x
  where x.project_id = pg_temp.id('prj_a2')),
  'so the board leaves out shifts on a project they only read');

select pg_temp.as_user('gina');
select is((select count(*)::int from app.my_shift_planning_projects((select id from world where key = 'org_a'))), 0,
  'a viewer plans on none');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.my_shift_planning_projects((select id from world where key = 'org_a'))), 0,
  'another org''s owner gets none of this org''s projects');

select pg_temp.as_anon();
select throws_ok($$select * from app.my_shift_planning_projects((select id from world where key = 'org_a'))$$,
  '42501', null, 'anon cannot call it');

select * from finish();
rollback;
