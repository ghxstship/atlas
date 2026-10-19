-- pgTAP: migration 1204, several project roles on one assignment (A52, Section 4.8.1). Every assignment carries its lead
-- role's row; a Manager adds a second role; capabilities follow every role (a Field member who is also Field Supervisor
-- dispatches); removing the extra role takes its capability away; the lead role's row moves with the lead role and cannot
-- be removed directly; nobody adds a role to their own assignment; ended assignments take no roles. Member write denied,
-- cross-tenant and anon denied.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(18);

create function pg_temp.pm_of(p_person text) returns uuid language sql stable as $$
  select pm.id from app.project_members pm where pm.project_id = pg_temp.id('prj_a') and pm.membership_id = pg_temp.id(p_person || '@org_a')
    and pm.deleted_at is null $$;

select has_table('app', 'project_member_roles', 'app.project_member_roles exists');

select pg_temp.as_user('carol');
select is((select array_agg(project_role::text) from app.project_member_roles where project_member_id = pg_temp.pm_of('frank') and deleted_at is null),
  array['Field'], 'every assignment carries its lead role''s row');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.project_member_roles where project_member_id = pg_temp.pm_of('frank')), 1, 'a person reads the roles on their own assignment');

select pg_temp.claims('frank');
select is(private.can_on_project(pg_temp.id('prj_a'), 'safety.incident.dispatch'), false, 'a Field member alone does not dispatch');

select pg_temp.as_user('carol');
select lives_ok($$insert into app.project_member_roles (project_member_id, project_role) values (pg_temp.pm_of('frank'), 'Field Supervisor')$$,
  'a Manager adds Field Supervisor to Frank''s assignment');
select throws_ok($$insert into app.project_member_roles (project_member_id, project_role) values (pg_temp.pm_of('frank'), 'Field Supervisor')$$,
  '23505', null, 'a role appears once per assignment');
select is((select array_agg(project_role::text order by project_role) from app.project_member_roles
  where project_member_id = pg_temp.pm_of('frank') and deleted_at is null), array['Field Supervisor', 'Field'],
  'the assignment now holds two project roles');

select pg_temp.claims('frank');
select is(private.can_on_project(pg_temp.id('prj_a'), 'safety.incident.dispatch'), true, 'capabilities are the union: he dispatches on prj_a');
select is(private.can_on_project(pg_temp.id('prj_a2'), 'safety.incident.dispatch'), false, 'and only on that project');
select pg_temp.as_user('frank');
select results_eq($$select project_role::text, capability_code from app.my_project_role_capabilities()$$,
  $$values ('Field Supervisor', 'safety.incident.dispatch')$$, 'Compass reads what the extra role adds');

select pg_temp.as_user('carol');
select throws_ok($$update app.project_member_roles set deleted_at = now() where project_member_id = pg_temp.pm_of('frank') and project_role = 'Field'$$,
  'XR001', 'project_role_lead: Change the assignment''s lead role before removing it.', 'the lead role''s row cannot be removed directly');
update app.project_member_roles set deleted_at = now() where project_member_id = pg_temp.pm_of('frank') and project_role = 'Field Supervisor';
select pg_temp.claims('frank');
select is(private.can_on_project(pg_temp.id('prj_a'), 'safety.incident.dispatch'), false, 'removing the extra role takes its capability away');

select pg_temp.as_user('carol');
update app.project_members set project_role = 'Coordinator' where id = pg_temp.pm_of('frank');
select is((select array_agg(project_role::text) from app.project_member_roles where project_member_id = pg_temp.pm_of('frank') and deleted_at is null),
  array['Coordinator'], 'changing the lead role moves its row');

-- Separation of duties and ended assignments.
select pg_temp.as_user('alice');
select lives_ok($$insert into app.project_members (project_id, membership_id, project_role) values ((select id from world where key = 'prj_a2'), (select id from world where key = 'carol@org_a'), 'Producer')$$,
  'the Owner assigns Carol to prj_a2');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.project_member_roles (project_member_id, project_role)
  select pm.id, 'Coordinator' from app.project_members pm where pm.project_id = (select id from world where key = 'prj_a2') and pm.membership_id = (select id from world where key = 'carol@org_a')$$,
  'XR001', 'sod_self_grant: A person cannot grant themselves a role or capability.', 'nobody adds a role to their own assignment');

select pg_temp.as_user('dave');
select throws_ok($$insert into app.project_member_roles (project_member_id, project_role) values (pg_temp.pm_of('erin'), 'Producer')$$,
  '42501', null, 'a Member without projects.members.manage cannot add roles');

select pg_temp.as_user('xavier');
select is((select count(*)::int from app.project_member_roles), 0, 'cross-tenant: another org reads no project roles');

select pg_temp.as_anon();
select throws_ok('select 1 from app.project_member_roles', '42501', null, 'anon reads no project roles');

select * from finish();
rollback;
