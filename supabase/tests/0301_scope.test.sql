-- pgTAP: scope (Section 7.4 Scope). Same-tenant allow, cross-tenant deny, anon deny, role band
-- boundaries, invariant 1 (tenancy), invariant 2 (project data readable by members and assigned
-- people), invariant 9 (gate transition), invariant 10 helper, the project and production state
-- machines (every transition allowed and refused), the scope tree and the domain event table.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(120);

create function pg_temp.visible_projects() returns uuid[]
language sql as $$ select coalesce(array_agg(id order by project_key), '{}') from app.projects $$;

-- Structure ------------------------------------------------------------------------------------
select has_table('app', t, 'app.' || t || ' exists') from unnest(array[
  'venues', 'counterparties', 'projects', 'project_state_transitions', 'production_state_transitions',
  'project_phase_transitions', 'project_members', 'scope_nodes', 'gate_evidence', 'domain_events']) t;
select has_trigger('app', t, 't95_append_only', 'app.' || t || ' is append-only') from unnest(array[
  'project_state_transitions', 'production_state_transitions', 'project_phase_transitions', 'domain_events']) t;

-- Same-tenant allow, cross-tenant deny, anon deny ---------------------------------------------------
select pg_temp.as_user('alice');
select is(pg_temp.visible_projects(), array[pg_temp.id('prj_a'), pg_temp.id('prj_a2')], 'the Northwind owner reads both Northwind projects and no other');
select is((select count(*)::int from app.scope_nodes where org_id = pg_temp.id('org_b')), 0, 'the Northwind owner reads no Harbor Lights scope nodes');
select is((select count(*)::int from app.venues where org_id = pg_temp.id('org_b')), 0, 'the Northwind owner reads no Harbor Lights venues');
select pg_temp.as_user('xavier');
select is(pg_temp.visible_projects(), array[pg_temp.id('prj_b')], 'the Harbor Lights owner reads only the Harbor Lights project');
select is((select count(*)::int from app.project_members where org_id = pg_temp.id('org_a')), 0, 'the Harbor Lights owner reads no Northwind project members');
select pg_temp.as_user('nina');
select is(pg_temp.visible_projects(), '{}'::uuid[], 'a person without membership reads no projects');
select pg_temp.as_anon();
select throws_ok('select 1 from app.projects', '42501', null, 'anon cannot read projects');
select throws_ok('select 1 from app.gate_evidence', '42501', null, 'anon cannot read gate evidence');
select throws_ok($$select app.pass_gate(gen_random_uuid(), 'SCP', 'x')$$, '42501', null, 'anon cannot call the gate RPC');
select pg_temp.as_platform();

-- Invariant 2 and role bands ---------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(pg_temp.visible_projects(), array[pg_temp.id('prj_a')], 'inv_02_project_read_scope: a Member reads only the project they belong to (invariant 2)');
select is((select count(*)::int from app.scope_nodes where project_id = pg_temp.id('prj_a2')), 0, 'a Member reads no scope nodes of a project they do not belong to');
select pg_temp.as_user('frank');
select is(pg_temp.visible_projects(), array[pg_temp.id('prj_a')], 'inv_02_project_read_scope: a Field member reads the project they are assigned to');
select pg_temp.as_user('gina');
select is(pg_temp.visible_projects(), '{}'::uuid[], 'inv_02_project_read_scope: a Viewer outside every project reads no projects, not the whole org');
select pg_temp.as_user('carol');
select is(pg_temp.visible_projects(), array[pg_temp.id('prj_a'), pg_temp.id('prj_a2')], 'a Manager oversees every project of the org');
select pg_temp.as_user('mia');
select is(pg_temp.visible_projects(), '{}'::uuid[], 'a Member and Field person in no project reads none');

select pg_temp.as_user('dave');
select throws_ok($$insert into app.projects (org_id, project_key, name, time_zone) values ((select id from world where key = 'org_a'), 'DAV', 'Dave Project', 'UTC')$$,
  '42501', null, 'a Member cannot create a project');
select throws_ok($$select app.transition_project((select id from world where key = 'prj_a'), 'Proposed', 'Active', 'Kickoff.')$$,
  '42501', null, 'a Member cannot change the project state');
select pg_temp.as_user('carol');
select lives_ok($$insert into app.projects (org_id, project_key, name, time_zone) values ((select id from world where key = 'org_a'), 'CAR', 'Carol Showcase', 'UTC')$$,
  'a Manager creates a project');
select pg_temp.as_user('erin');
select is_empty($$update app.projects set name = 'Renamed' where id = (select id from world where key = 'prj_a2') returning id$$,
  'a Collaborator cannot touch a project outside their assignment');
select is((select count(*)::int from app.projects where id = pg_temp.id('prj_a2')), 0, 'and cannot even see it');
select pg_temp.as_platform();

-- Keys, tenancy and guards (invariant 1) -------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok($$insert into app.projects (org_id, project_key, name, time_zone) values ((select id from world where key = 'org_a'), 'nwl2', 'Bad Key', 'UTC')$$,
  '23514', null, 'a project key is two to five capital letters');
select throws_ok($$insert into app.projects (org_id, project_key, name, time_zone) values ((select id from world where key = 'org_a'), 'NWL', 'Duplicate', 'UTC')$$,
  '23505', null, 'a project key is unique within the org');
select throws_ok($$insert into app.projects (org_id, project_key, name, time_zone) values ((select id from world where key = 'org_a'), 'TZQ', 'Bad Zone', 'Mars/Olympus')$$,
  'XR001', 'time_zone_unknown: Mars/Olympus is not an IANA time zone.', 'a project time zone must be an IANA zone');
select throws_ok($$insert into app.projects (org_id, project_key, name, time_zone, venue_id) values ((select id from world where key = 'org_a'), 'XVN', 'Cross Venue', 'UTC', (select id from world where key = 'venue_b'))$$,
  'XR001', null, 'a project cannot use a venue of another org');
select throws_ok($$insert into app.projects (org_id, project_key, name, time_zone, project_state) values ((select id from world where key = 'org_a'), 'STQ', 'Started', 'UTC', 'Active')$$,
  'XR001', null, 'a project starts Proposed');
select throws_ok($$update app.projects set project_state = 'Active' where id = (select id from world where key = 'prj_a')$$,
  'XR001', 'project_transition_rpc_only: project_state changes only through its transition RPC, which logs the change.', 'the project state changes only through its RPC');
select throws_ok($$update app.projects set current_phase_code = 'ENG' where id = (select id from world where key = 'prj_a')$$,
  'XR001', null, 'the phase changes only through the gate RPC');
select throws_ok($$update app.projects set org_id = (select id from world where key = 'org_b') where id = (select id from world where key = 'prj_a')$$,
  'XR001', null, 'a project cannot move to another org');
select lives_ok($$insert into app.scope_nodes (org_id, project_id, parent_id, scope_kind, scope_code, name)
  values ((select id from world where key = 'org_b'), (select id from world where key = 'prj_a'), (select id from world where key = 'root_a'), 'Show', 'NWL-E02', 'Second Night')$$,
  'a scope node insert with a forged org_id succeeds');
select is((select org_id from app.scope_nodes where scope_code = 'NWL-E02'), pg_temp.id('org_a'), 'and its org_id is derived from the project, not the caller');
select lives_ok($$update app.projects set name = 'Northwind Summer Series 2027' where id = (select id from world where key = 'prj_a')$$, 'an owner edits the project');
select pg_temp.as_user('carol');
select lives_ok($$update app.projects set project_key = 'NWS' where id = (select id from world where key = 'prj_a2')$$, 'a Manager changes the project key');
select pg_temp.as_user('dave');
select throws_ok($$update app.projects set project_key = 'NWQ' where id = (select id from world where key = 'prj_a')$$,
  '42501', null, 'a Member cannot change the project key');
select pg_temp.as_platform();

-- Plan limit ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('xavier');
-- The first project is free on Access; it allows one active project (ADR 0018, seed 0900).
select throws_ok($$insert into app.projects (org_id, project_key, name, time_zone) values ((select id from world where key = 'org_b'), 'HLQ', 'Harbor Second', 'UTC')$$,
  'XR001', null, 'the Access plan refuses a second active project');
select is((select count(*) from app.projects where org_id = (select id from world where key = 'org_b') and deleted_at is null),
  1::bigint, 'the Access org keeps its one free project');
select pg_temp.as_platform();

-- Project state machine -------------------------------------------------------------------------------------------
create temporary table project_moves (from_state text, to_state text, allowed boolean);
insert into project_moves select f.e::text, t.e::text,
  exists (select 1 from private.lifecycle_transition_rules r where r.lifecycle = 'project' and r.from_state = f.e::text and r.to_state = t.e::text)
from unnest(enum_range(null::app.project_state)) f(e) cross join unnest(enum_range(null::app.project_state)) t(e) where f.e <> t.e;
select is((select count(*)::int from project_moves where allowed), 8, 'the project lifecycle allows eight moves');
select is(
  (select string_agg(from_state || '>' || to_state, ' ' order by from_state, to_state) from project_moves where allowed),
  'Active>Blocked Active>Canceled Active>Complete Blocked>Active Blocked>Canceled Complete>Active Proposed>Active Proposed>Canceled',
  'the project moves are exactly the declared ones');

select pg_temp.as_user('alice');
select throws_ok($$select app.transition_project((select id from world where key = 'prj_a'), 'Proposed', 'Complete', 'Skip.')$$,
  'XR001', 'project_transition_not_allowed: A project cannot move from Proposed to Complete.', 'Proposed cannot jump to Complete');
select throws_ok($$select app.transition_project((select id from world where key = 'prj_a'), 'Active', 'Blocked', 'Stale.')$$,
  'XR001', null, 'a stale expected state is refused (compare-and-set)');
select throws_ok($$select app.transition_project((select id from world where key = 'prj_a'), 'Proposed', 'Active', ' ')$$,
  'XR001', null, 'a transition needs a reason');
select lives_ok($$select app.transition_project((select id from world where key = 'prj_a'), 'Proposed', 'Active', 'Signed.')$$, 'Proposed to Active');
select lives_ok($$select app.transition_project((select id from world where key = 'prj_a'), 'Active', 'Blocked', 'Venue hold.')$$, 'Active to Blocked');
select lives_ok($$select app.transition_project((select id from world where key = 'prj_a'), 'Blocked', 'Active', 'Hold lifted.')$$, 'Blocked to Active');
select lives_ok($$select app.transition_project((select id from world where key = 'prj_a'), 'Active', 'Complete', 'Delivered.')$$, 'Active to Complete');
select lives_ok($$select app.transition_project((select id from world where key = 'prj_a'), 'Complete', 'Active', 'Reopened.')$$, 'Complete to Active');
select lives_ok($$select app.transition_project((select id from world where key = 'prj_a2'), 'Proposed', 'Canceled', 'Lost the bid.')$$, 'Proposed to Canceled');
select throws_ok($$select app.transition_project((select id from world where key = 'prj_a2'), 'Canceled', 'Active', 'Revive.')$$, 'XR001', 'project_transition_not_allowed: A project cannot move from Canceled to Active.', 'Canceled is terminal');
select is((select count(*)::int from app.project_state_transitions where project_id = pg_temp.id('prj_a')), 6, 'the creation entry and five moves are in the ledger');
select is((select count(*)::int from app.domain_events where event_type = 'project.state_changed' and project_id = pg_temp.id('prj_a')), 5, 'each move emitted project.state_changed');
select pg_temp.as_platform();
select throws_ok($$update app.project_state_transitions set reason = 'Edited.'$$, 'XR001', null, 'the project state ledger is append-only');

-- Production state machine and invariant 10 -----------------------------------------------------------------------------
select is((select count(*)::int from private.lifecycle_transition_rules where lifecycle = 'production'), 9, 'the production lifecycle allows nine moves');
select ok(not exists (select 1 from private.lifecycle_transition_rules where lifecycle = 'production' and from_state = 'Closed'), 'Closed is terminal');
select pg_temp.as_user('alice');
select lives_ok($$select app.transition_production((select id from world where key = 'prj_a'), 'Proposed', 'Active', 'Load-in.')$$, 'production Proposed to Active');
select throws_ok($$select app.transition_production((select id from world where key = 'prj_a'), 'Active', 'Closed', 'Skip.')$$, 'XR001', 'production_transition_not_allowed: A production cannot move from Active to Closed.', 'an Active production cannot close without completing');
select lives_ok($$select app.transition_production((select id from world where key = 'prj_a'), 'Active', 'Complete', 'Wrapped.')$$, 'production Active to Complete');
select pg_temp.as_platform();
select lives_ok($$select private.assert_production_open((select id from world where key = 'prj_a'))$$, 'a Complete production is still open for spend');
select pg_temp.as_user('alice');
select lives_ok($$select app.transition_production((select id from world where key = 'prj_a'), 'Complete', 'Closed', 'Books closed.')$$, 'production Complete to Closed');
select throws_ok($$select app.transition_production((select id from world where key = 'prj_a'), 'Closed', 'Active', 'Reopen.')$$, 'XR001', 'production_transition_not_allowed: A production cannot move from Closed to Active.', 'a Closed production cannot reopen');
select pg_temp.as_platform();
select throws_ok($$select private.assert_production_open((select id from world where key = 'prj_a'))$$,
  'XR001', null, 'inv_10_closed_production: a Closed production refuses new spend (invariant 10)');

-- Gate transition (invariant 9) ---------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.pass_gate((select id from world where key = 'prj_b'), 'SCP', 'Go.')$$,
  '42501', null, 'a Northwind Manager cannot pass a Harbor Lights gate');
select throws_ok($$select app.pass_gate((select id from world where key = 'prj_a2'), 'SCP', 'Go.')$$,
  'XR001', null, 'a canceled project passes no gates');
select pg_temp.as_user('dave');
select throws_ok($$select app.pass_gate((select id from world where key = 'prj_a'), 'SCP', 'Go.')$$,
  'XR001', 'gate_criteria_unmet: Gate 1 needs evidence for every blocking criterion; missing: G1.BUDGET_ENVELOPE, G1.GONOGO, G1.JURISDICTION, G1.SCOPE_LOCK.',
  'inv_09_gate_transition: a gate with unevidenced blocking criteria is refused, naming them');
select lives_ok($$insert into app.gate_evidence (project_id, criterion_id, evidence_uri, assertion_rank)
  select (select id from world where key = 'prj_a'), c, 'docs/' || c || '.pdf', 0 from unnest(array['G1.BUDGET_ENVELOPE', 'G1.GONOGO', 'G1.JURISDICTION', 'G1.SCOPE_LOCK']) c$$,
  'a Member attests rank 0 evidence on an assigned project');
select throws_ok($$select app.pass_gate((select id from world where key = 'prj_a'), 'SCP', 'Go.')$$,
  'XR001', null, 'rank 0 evidence is an absent claim and does not satisfy a criterion');
select lives_ok($$insert into app.gate_evidence (project_id, criterion_id, evidence_uri, assertion_rank)
  select (select id from world where key = 'prj_a'), c, 'docs/' || c || '-signed.pdf', 4 from unnest(array['G1.BUDGET_ENVELOPE', 'G1.GONOGO', 'G1.JURISDICTION']) c$$,
  'three blocking criteria get rank 4 evidence');
select throws_ok($$select app.pass_gate((select id from world where key = 'prj_a'), 'SCP', 'Go.')$$,
  'XR001', 'gate_criteria_unmet: Gate 1 needs evidence for every blocking criterion; missing: G1.SCOPE_LOCK.', 'one missing blocking criterion still refuses');
select lives_ok($$insert into app.gate_evidence (project_id, criterion_id, evidence_uri, assertion_rank) values ((select id from world where key = 'prj_a'), 'G1.SCOPE_LOCK', 'docs/scope-lock.pdf', 3)$$,
  'the last blocking criterion gets evidence');
select is((select attested_by from app.gate_evidence where evidence_uri = 'docs/scope-lock.pdf'), pg_temp.id('dave'), 'evidence is attested by the session person');
select throws_ok($$select app.pass_gate((select id from world where key = 'prj_a'), 'ENG', 'Go.')$$,
  'XR001', null, 'inv_09_gate_transition: a wrong expected phase is refused (compare-and-set)');
select is(app.pass_gate(pg_temp.id('prj_a'), 'SCP', 'Go decision recorded.'), 'ENG', 'inv_09_gate_transition: gate 1 passes once every blocking criterion has evidence');
select is((select current_phase_code from app.projects where id = pg_temp.id('prj_a')), 'ENG', 'the project is now in Engage');
select throws_ok($$select app.pass_gate((select id from world where key = 'prj_a'), 'SCP', 'Again.')$$,
  'XR001', null, 'the same gate cannot be passed twice');
select is((select count(*)::int from app.project_phase_transitions where project_id = pg_temp.id('prj_a') and gate = 1 and to_phase_code = 'ENG'), 1, 'the phase ledger records gate 1');
select throws_ok($$update app.gate_evidence set note = 'Edited.' where evidence_uri = 'docs/scope-lock.pdf'$$,
  'XR001', null, 'evidence cannot be edited');
select lives_ok($$update app.gate_evidence set deleted_at = now() where evidence_uri = 'docs/scope-lock.pdf'$$, 'evidence can be withdrawn');
select throws_ok($$insert into app.gate_evidence (project_id, criterion_id, assertion_rank) values ((select id from world where key = 'prj_a'), 'G2.CONTRACTS', 2)$$,
  'XR001', null, 'evidence must reference a document or record');
select pg_temp.as_user('erin');
select throws_ok($$select app.pass_gate((select id from world where key = 'prj_a'), 'ENG', 'Go.')$$, '42501', null, 'a Collaborator cannot pass a gate');
select pg_temp.as_user('gina');
select throws_ok($$insert into app.gate_evidence (project_id, criterion_id, evidence_uri, assertion_rank) values ((select id from world where key = 'prj_a'), 'G2.CONTRACTS', 'x.pdf', 2)$$,
  '42501', null, 'a Viewer cannot attest evidence');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.domain_events where event_type = 'project.gate_passed' and project_id = pg_temp.id('prj_a')), 1, 'passing the gate emitted project.gate_passed');
select is((select count(*)::int from app.gate_criteria_status where project_id = pg_temp.id('prj_a') and gate = 1 and is_blocking and evidence_count = 0), 1,
  'gate readiness shows the withdrawn criterion as unmet again');
select pg_temp.as_platform();

-- Project members --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$insert into app.project_members (project_id, membership_id, project_role) values ((select id from world where key = 'prj_a2'), (select id from world where key = 'carol@org_a'), 'Producer')$$,
  'XR001', 'sod_self_grant: A person cannot grant themselves a role or capability.', 'a person cannot add themselves to a project');
select lives_ok($$insert into app.project_members (project_id, membership_id, project_role) values ((select id from world where key = 'prj_a2'), (select id from world where key = 'gina@org_a'), 'Field Supervisor')$$,
  'a Manager adds a member');
select throws_ok($$insert into app.project_members (project_id, membership_id, project_role) values ((select id from world where key = 'prj_a2'), (select id from world where key = 'xavier@org_b'), 'Field')$$,
  'XR001', null, 'a project member must hold a membership of the project''s org');
select pg_temp.as_user('gina');
select is(pg_temp.visible_projects(), array[pg_temp.id('prj_a2')], 'a Viewer reads the project once added to it');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.project_members (project_id, membership_id, project_role) values ((select id from world where key = 'prj_a'), (select id from world where key = 'mia@org_a'), 'Field')$$,
  '42501', null, 'a Member cannot manage project members');
select pg_temp.as_platform();

-- Scope tree ----------------------------------------------------------------------------------------------------------------
select is((select path::text from app.scope_nodes where id = pg_temp.id('show_a')), 'NWL.NWL_E01', 'a show''s path runs from the root');
select pg_temp.as_user('alice');
select throws_ok($$insert into app.scope_nodes (project_id, scope_kind, scope_code, name) values ((select id from world where key = 'prj_a'), 'Engagement Root', 'NWL2', 'Second Root')$$,
  '23505', null, 'a project has one engagement root');
select throws_ok($$insert into app.scope_nodes (project_id, scope_kind, scope_code, name) values ((select id from world where key = 'prj_a'), 'Show', 'NWL-E09', 'Orphan')$$,
  '23514', null, 'only the engagement root has no parent');
select throws_ok($$insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name) values ((select id from world where key = 'prj_a'), (select id from world where key = 'root_a2'), 'Show', 'NWL-E08', 'Wrong Tree')$$,
  'XR001', null, 'a parent must belong to the same project');
select throws_ok($$update app.scope_nodes set scope_code = 'NWL-E99' where id = (select id from world where key = 'show_a')$$,
  'XR001', null, 'a scope node keeps its code');
select pg_temp.as_user('dave');
select lives_ok($$insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name) values ((select id from world where key = 'prj_a'), (select id from world where key = 'root_a'), 'Standing Venue', 'NWL-V01', 'Pier Pavilion')$$,
  'a Member writes the scope tree of an assigned project');
select pg_temp.as_platform();

-- Scope helpers (ADR 0008) --------------------------------------------------------------------------------------------------
select is(private.scope_org('project', pg_temp.id('prj_b')), pg_temp.id('org_b'), 'scope_org resolves a project');
select pg_temp.claims('dave');
select ok(private.is_assigned_to_scope(pg_temp.id('org_a'), pg_temp.id('prj_a')), 'a project member is assigned to the project scope');
select ok(private.is_assigned_to_scope(pg_temp.id('org_a'), pg_temp.id('show_a')), 'and to its scope nodes');
select ok(not private.is_assigned_to_scope(pg_temp.id('org_a'), pg_temp.id('prj_a2')), 'but not to another project');
select ok(private.has_capability(pg_temp.id('org_a'), 'projects.gate.transition', pg_temp.id('prj_a')), 'assigned reach applies on the member''s project');
select ok(not private.has_capability(pg_temp.id('org_a'), 'projects.gate.transition', pg_temp.id('prj_a2')), 'and not on another project');
select pg_temp.as_user('alice');
select lives_ok($$insert into app.user_capability_grants (membership_id, capability_code, scope_kind, scope_id, reason)
  values ((select id from world where key = 'mia@org_a'), 'projects.project.read', 'project', (select id from world where key = 'prj_a2'), 'Gala review.')$$,
  'a grant scoped to a project resolves now that projects are known');
select pg_temp.as_user('mia');
select is(pg_temp.visible_projects(), array[pg_temp.id('prj_a2')], 'a project-scoped grant makes the project readable');
select pg_temp.as_platform();

-- Counterparties --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select lives_ok($$insert into world values ('cp_a', app.create_counterparty((select id from world where key = 'org_a'), 'Lumen Staging Co', 'Equipment Rental'))$$,
  'an owner records a new counterparty company');
select is((select app.counterparty_name(c) from app.counterparties c where c.id = pg_temp.id('cp_a')), 'Lumen Staging Co', 'the counterparty name is read from the organization');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.counterparties where id = pg_temp.id('cp_a')), 0, 'another org cannot see the counterparty');
select pg_temp.as_platform();
select is((select app.counterparty_name(c) from app.counterparties c where c.id = pg_temp.id('cp_a')), null, 'a caller outside the org gets no name from the computed field');

-- Domain events -------------------------------------------------------------------------------------------------------------------
select ok((select count(*) from app.domain_events where event_type = 'project.created') >= 3, 'project creation emits project.created');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.domain_events), 0, 'a Viewer cannot read the webhook event table');
select pg_temp.as_platform();
select throws_ok($$delete from app.domain_events$$, 'XR001', null, 'the domain event table is append-only');

select * from finish();
rollback;
