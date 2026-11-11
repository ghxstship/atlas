-- pgTAP: incident dispatch leaves the Member and Collaborator system roles (crawl 4.9, the 1110 owner decision).
-- dave (member) and erin (collaborator) are project members of prj_a: they still report incidents, but no longer
-- dispatch a responder or announce a crisis alert. The manager band still dispatches org-wide, and the notices to a
-- project's dispatchers reach its Field Supervisor (frank, once given the role) and no longer the member or collaborator.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(17);

-- The seed --------------------------------------------------------------------------------------------------------
select is((select count(*)::int from app.role_capabilities rc join app.roles r on r.id = rc.role_id
  where r.org_id is null and r.code in ('member', 'collaborator') and rc.capability_code = 'safety.incident.dispatch'
    and rc.deleted_at is null), 0,
  'the Member and Collaborator system roles no longer hold incident dispatch');
select is((select count(*)::int from app.role_capabilities rc join app.roles r on r.id = rc.role_id
  where r.org_id is null and r.code in ('member', 'collaborator') and rc.capability_code = 'safety.incident.write'
    and rc.deleted_at is null), 2,
  'both still report incidents');
select is((select array_agg(r.code order by r.band) from app.role_capabilities rc join app.roles r on r.id = rc.role_id
  where r.org_id is null and rc.capability_code = 'safety.incident.dispatch' and rc.deleted_at is null),
  array['owner', 'admin', 'manager'], 'only the manager band holds dispatch among the system roles');

-- A member on the project -----------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select ok((select id from app.report_incident(pg_temp.id('prj_a'), 'Spill at Bar 3', 'ENM-100', now(), null, 25.8, -80.2, 8, now(),
  '01920000-0000-7000-8000-00000000e101'::uuid)) is not null, 'a member on the project reports an incident');
insert into world values ('inc', '01920000-0000-7000-8000-00000000e101');
select throws_ok($$select app.dispatch_responder((select id from world where key = 'inc'), (select id from world where key = 'frank@org_a'))$$,
  '42501', null, 'but can no longer dispatch a responder');
select throws_ok($$insert into app.crisis_alerts (org_id, project_id, emergency_code, message)
  values ((select id from world where key = 'org_a'), (select id from world where key = 'prj_a'),
          (select c.code from xpms.emergency_code c order by c.sort_order limit 1), 'Evacuate the north stage.')$$,
  '42501', null, 'nor announce a crisis alert');
select pg_temp.claims('dave');
select is(private.can_on_project(pg_temp.id('prj_a'), 'safety.incident.dispatch'), false,
  'dispatch is not among a member''s capabilities on the project');
select is(private.can_on_project(pg_temp.id('prj_a'), 'safety.incident.write'), true,
  'reporting still is');

-- A collaborator on the project -----------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select throws_ok($$select app.dispatch_responder((select id from world where key = 'inc'), (select id from world where key = 'frank@org_a'))$$,
  '42501', null, 'a collaborator on the project cannot dispatch a responder');
select throws_ok($$insert into app.crisis_alerts (org_id, project_id, emergency_code, message)
  values ((select id from world where key = 'org_a'), (select id from world where key = 'prj_a'),
          (select c.code from xpms.emergency_code c order by c.sort_order limit 1), 'Evacuate the north stage.')$$,
  '42501', null, 'nor announce a crisis alert');
select pg_temp.claims('erin');
select is(private.can_on_project(pg_temp.id('prj_a'), 'safety.incident.dispatch'), false,
  'dispatch is not among a collaborator''s capabilities on the project');

-- The manager band ------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(app.dispatch_responder(pg_temp.id('inc'), pg_temp.id('frank@org_a'), '01920000-0000-7000-8000-00000000e102'::uuid),
  '01920000-0000-7000-8000-00000000e102'::uuid, 'a Manager still dispatches');
select lives_ok($$insert into app.crisis_alerts (org_id, project_id, emergency_code, message)
  values ((select id from world where key = 'org_a'), (select id from world where key = 'prj_a'),
          (select c.code from xpms.emergency_code c order by c.sort_order limit 1), 'Evacuate the north stage.')$$,
  'and announces a crisis alert');

-- Who the project's dispatcher notices reach -----------------------------------------------------------------------
select pg_temp.as_platform();
select ok(pg_temp.id('carol') in (select private.project_member_people_with(pg_temp.id('prj_a'), 'safety.incident.dispatch')),
  'the Manager is among the project''s dispatchers');
select ok(pg_temp.id('dave') not in (select private.project_member_people_with(pg_temp.id('prj_a'), 'safety.incident.dispatch'))
  and pg_temp.id('erin') not in (select private.project_member_people_with(pg_temp.id('prj_a'), 'safety.incident.dispatch')),
  'the member and the collaborator are not');
insert into app.project_member_roles (project_member_id, project_role)
select pm.id, 'Field Supervisor' from app.project_members pm
where pm.project_id = pg_temp.id('prj_a') and pm.membership_id = pg_temp.id('frank@org_a') and pm.deleted_at is null;
select ok(pg_temp.id('frank') in (select private.project_member_people_with(pg_temp.id('prj_a'), 'safety.incident.dispatch')),
  'the project''s Field Supervisor is, as he dispatches there');
select ok(pg_temp.id('frank') not in (select private.project_member_people_with(pg_temp.id('prj_a2'), 'safety.incident.dispatch')),
  'on that project only');

select * from finish();
rollback;
