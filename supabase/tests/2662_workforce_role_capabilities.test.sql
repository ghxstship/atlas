-- pgTAP: migration 2662 (R6a, ADR 0105), canon workforce roles that add a capability on their project. The catering
-- lead (8000.51.01) and on-site medical (7000.51.01) hold data.restricted.read.medical on a project while their
-- assignment there is Active and current, in one of their orgs and within API-key scopes; never on another project,
-- while Proposed, after it ends, or for a role the mapping does not name. Nobody activates their own mapped
-- assignment (sod_self_grant); another manager does. 1110, 1204 and 1205 keep their own project_ids_with tests.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(19);

-- The capability as someone sees it on a project, back as the platform.
create function pg_temp.medical(p_who text, p_project text) returns boolean
language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.claims(p_who);
  v := private.can_on_project(pg_temp.id(p_project), 'data.restricted.read.medical');
  perform pg_temp.as_platform();
  return v;
end $$;

-- The mapping ------------------------------------------------------------------------------------------------------------------
select has_table('private', 'workforce_role_capabilities', 'private.workforce_role_capabilities exists');
select results_eq($$select role_code, capability_code from private.workforce_role_capabilities order by role_code$$,
  $$values ('7000.51.01'::text, 'data.restricted.read.medical'::text), ('8000.51.01', 'data.restricted.read.medical')$$,
  'on-site medical and the catering lead read medical data on their project');
select ok(not has_table_privilege('authenticated', 'private.workforce_role_capabilities', 'select'),
  'signed-in callers never read the mapping');
select ok(not pg_temp.medical('dave', 'prj_a'), 'a member without the role does not hold the capability');

-- An Active, current assignment adds it on its project --------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.role_assignments (project_id, role_code, person_id)
  values (pg_temp.id('prj_a'), '7000.51.01', pg_temp.id('dave')) returning id) insert into world select 'ra_dave', id from x;
select pg_temp.as_platform();
select ok(not pg_temp.medical('dave', 'prj_a'), 'not while the assignment is Proposed');
select pg_temp.as_user('carol');
select app.transition_role_assignment(pg_temp.id('ra_dave'), 'Proposed', 'Active', 'On the medical tent.');
select pg_temp.as_platform();
select ok(pg_temp.medical('dave', 'prj_a'), 'an Active Event medical assignment adds the capability on its project');
select ok(not pg_temp.medical('dave', 'prj_a2'), 'and on no other project');
select pg_temp.claims('dave');
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('dave_user'), 'role', 'authenticated', 'scopes', json_build_array('crew'),
  'amr', json_build_array(json_build_object('method', 'xos_api_key', 'timestamp', 0)))::text, true);
select is(private.can_on_project(pg_temp.id('prj_a'), 'data.restricted.read.medical'), false,
  'an API key without the data scope does not reach it (A22-001)');
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('dave_user'), 'role', 'authenticated', 'scopes', json_build_array('data'),
  'amr', json_build_array(json_build_object('method', 'xos_api_key', 'timestamp', 0)))::text, true);
select is(private.can_on_project(pg_temp.id('prj_a'), 'data.restricted.read.medical'), true, 'one with the data scope does');
select pg_temp.as_platform();

select pg_temp.as_user('carol');
with x as (insert into app.role_assignments (project_id, role_code, person_id)
  values (pg_temp.id('prj_a'), '8000.51.01', pg_temp.id('erin')) returning id) insert into world select 'ra_erin', id from x;
select app.transition_role_assignment(pg_temp.id('ra_erin'), 'Proposed', 'Active', 'Running crew catering.');
with x as (insert into app.role_assignments (project_id, role_code, person_id)
  values (pg_temp.id('prj_a'), '6000.52.01', pg_temp.id('frank')) returning id) insert into world select 'ra_frank', id from x;
select app.transition_role_assignment(pg_temp.id('ra_frank'), 'Proposed', 'Active', 'Working the stage.');
select pg_temp.as_platform();
select ok(pg_temp.medical('erin', 'prj_a'), 'so does an Active Catering supervision assignment');
select ok(not pg_temp.medical('frank', 'prj_a'), 'a role the mapping does not name adds nothing');

-- An assignment outside its dates, or ended, adds nothing ----------------------------------------------------------------
select pg_temp.as_user('carol');
update app.role_assignments set starts_on = current_date - 10, ends_on = current_date - 1 where id = pg_temp.id('ra_erin');
select pg_temp.as_platform();
select ok(not pg_temp.medical('erin', 'prj_a'), 'not after the assignment''s last day');
select pg_temp.as_user('carol');
update app.role_assignments set starts_on = current_date + 1, ends_on = null where id = pg_temp.id('ra_erin');
select pg_temp.as_platform();
select ok(not pg_temp.medical('erin', 'prj_a'), 'nor before its first day');
select pg_temp.as_user('carol');
select app.transition_role_assignment(pg_temp.id('ra_dave'), 'Active', 'Complete', 'Show wrapped.');
select pg_temp.as_platform();
select ok(not pg_temp.medical('dave', 'prj_a'), 'nor once it is Complete');

-- Separation of duties ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_like(format($$insert into app.role_assignments (project_id, role_code, person_id, assignment_state)
  values (%L, '7000.51.01', %L, 'Active')$$, pg_temp.id('prj_a'), pg_temp.id('carol')), 'sod_self_grant:%',
  'a manager never inserts their own mapped assignment as Active');
with x as (insert into app.role_assignments (project_id, role_code, person_id)
  values (pg_temp.id('prj_a'), '7000.51.01', pg_temp.id('carol')) returning id) insert into world select 'ra_carol', id from x;
select throws_like(format($$select app.transition_role_assignment(%L, 'Proposed', 'Active', 'Covering medical.')$$, pg_temp.id('ra_carol')),
  'sod_self_grant:%', 'nor activates it');
select pg_temp.as_user('bob');
select lives_ok(format($$select app.transition_role_assignment(%L, 'Proposed', 'Active', 'Covering medical.')$$, pg_temp.id('ra_carol')),
  'another manager activates it');
select pg_temp.as_platform();
select ok(pg_temp.medical('carol', 'prj_a'), 'and the capability follows');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.transition_role_assignment(%L, 'Active', 'Complete', 'Done.')$$, pg_temp.id('ra_carol')),
  'the person still ends their own assignment');
select pg_temp.as_platform();

select * from finish();
rollback;
