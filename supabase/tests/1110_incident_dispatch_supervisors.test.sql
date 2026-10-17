-- pgTAP: incident dispatch belongs to Field Supervisors and the manager band, not to the Field role (A42, SIM-007).
-- Role bands: Field reports but never dispatches; a Field member holding the Field Supervisor project role
-- dispatches on that project only, while the role is active and within API-key scopes; Manager and above
-- dispatch org-wide. Cross-tenant and anon denied.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(17);

-- The seed --------------------------------------------------------------------------------------------------------
select is((select count(*)::int from app.role_capabilities rc join app.roles r on r.id = rc.role_id
  where r.org_id is null and r.code = 'field' and rc.capability_code = 'safety.incident.dispatch' and rc.deleted_at is null), 0,
  'the Field system role no longer holds incident dispatch');
select is((select count(*)::int from app.role_capabilities rc join app.roles r on r.id = rc.role_id
  where r.org_id is null and r.code = 'field' and rc.capability_code = 'safety.incident.write' and rc.deleted_at is null), 1,
  'Field still reports incidents');
select is((select array_agg(r.code order by r.band) from app.role_capabilities rc join app.roles r on r.id = rc.role_id
  where r.org_id is null and rc.capability_code = 'safety.incident.dispatch' and rc.reach = 'organization' and rc.deleted_at is null),
  array['owner', 'admin', 'manager'], 'the manager band holds dispatch at organization reach');

-- sam: a Field member who is the Field Supervisor on prj_a --------------------------------------------------------
select pg_temp.new_user('sam', 'sam@northwind.example.com', 'Sam Field Supervisor');
select pg_temp.join_org('alice', 'org_a', 'sam', 'field');
select pg_temp.as_user('carol');
with x as (insert into app.project_members (project_id, membership_id, project_role)
  values (pg_temp.id('prj_a'), pg_temp.id('sam@org_a'), 'Field Supervisor') returning id)
  insert into world select 'sam_pm', id from x;

select pg_temp.as_user('frank');
select ok((select id from app.report_incident(pg_temp.id('prj_a'), 'Spill at Bar 3', 'ENM-100', now(), null, 25.8, -80.2, 8, now(),
  '01920000-0000-7000-8000-00000000d101'::uuid)) is not null, 'a Field member reports an incident');
insert into world values ('inc', '01920000-0000-7000-8000-00000000d101');
select throws_ok($$select app.dispatch_responder((select id from world where key = 'inc'), (select id from world where key = 'frank@org_a'))$$,
  '42501', null, 'but a Field member can no longer dispatch a responder');
select throws_ok($$insert into app.dispatch_assignments (incident_id, membership_id) values ((select id from world where key = 'inc'), (select id from world where key = 'frank@org_a'))$$,
  '42501', null, 'nor write a dispatch row directly');
select is((select count(*)::int from app.my_project_role_capabilities()), 0, 'a plain Field member''s project role adds nothing');

select pg_temp.as_user('sam');
select is(app.dispatch_responder(pg_temp.id('inc'), pg_temp.id('frank@org_a'), '01920000-0000-7000-8000-00000000d102'::uuid),
  '01920000-0000-7000-8000-00000000d102'::uuid, 'the Field Supervisor on the project dispatches a responder');
select results_eq($$select project_id, project_role::text, capability_code from app.my_project_role_capabilities()$$,
  $$values ((select id from world where key = 'prj_a'), 'Field Supervisor', 'safety.incident.dispatch')$$,
  'Compass reads the dispatch the Field Supervisor role adds on prj_a');
select pg_temp.claims('sam');
select is(private.can_on_project(pg_temp.id('prj_a2'), 'safety.incident.dispatch'), false,
  'the project role adds dispatch on its own project only');
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('sam_user'), 'role', 'authenticated', 'scopes', json_build_array('crew'),
  'amr', json_build_array(json_build_object('method', 'xos_api_key', 'timestamp', 0)))::text, true);
select is(private.can_on_project(pg_temp.id('prj_a'), 'safety.incident.dispatch'), false,
  'an API key without the safety scope does not reach the project role''s dispatch (A22-001)');

-- Ending the project role takes dispatch away.
select pg_temp.as_user('carol');
update app.project_members set deleted_at = now() where id = pg_temp.id('sam_pm');
select pg_temp.as_user('sam');
select throws_ok($$select app.dispatch_responder((select id from world where key = 'inc'), (select id from world where key = 'frank@org_a'))$$,
  '42501', null, 'once the Field Supervisor role ends, dispatch ends with it');
select is((select count(*)::int from app.my_project_role_capabilities()), 0, 'and Compass no longer reads it');

-- Manager band, other org, anon -----------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(app.dispatch_responder(pg_temp.id('inc'), pg_temp.id('frank@org_a'), '01920000-0000-7000-8000-00000000d103'::uuid),
  '01920000-0000-7000-8000-00000000d103'::uuid, 'a Manager dispatches org-wide');
select pg_temp.as_user('xavier');
select throws_ok($$select app.dispatch_responder((select id from world where key = 'inc'), (select id from world where key = 'frank@org_a'))$$,
  '42501', null, 'another org cannot dispatch on this incident');
select pg_temp.as_anon();
select throws_ok('select * from app.my_project_role_capabilities()', '42501', null, 'anon cannot read project role capabilities');
select pg_temp.as_platform();
select is(has_table_privilege('authenticated', 'private.project_role_capabilities', 'SELECT'), false,
  'the project role list stays private; only the definer helpers read it');

select * from finish();
rollback;
