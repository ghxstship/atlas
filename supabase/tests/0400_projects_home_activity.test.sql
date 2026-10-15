-- pgTAP: A07 projects, home and activity (migration 0400). Project creation with its scope root
-- (allowed and refused by role band, tenant and anon), the scope removal invariant, the domain
-- events of project changes, and the activity feed rule: activity.feed.read in the org, org events
-- at organization reach, project events only for people who may read the project (invariant 2).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(45);

create function pg_temp.events(p_type text, p_subject uuid) returns int
language sql as $$
  select count(*)::int from app.domain_events e where e.event_type = p_type and e.subject_id = p_subject
$$;

create function pg_temp.feed_types(p_org text, p_project text default null) returns text[]
language sql as $$
  select coalesce(array_agg(distinct f.event_type order by f.event_type), '{}')
  from app.activity_feed(pg_temp.id(p_org), pg_temp.id(p_project), null, 200) f
$$;

create function pg_temp.feed_projects(p_org text) returns text[]
language sql as $$
  select coalesce(array_agg(distinct f.project_key order by f.project_key), '{}')
  from app.activity_feed(pg_temp.id(p_org), null, null, 200) f where f.project_key is not null
$$;

-- Structure -----------------------------------------------------------------------------------
select has_function('app', 'create_project', 'app.create_project exists');
select has_function('app', 'activity_feed', 'app.activity_feed exists');
select ok((select count(*) = 8 from private.domain_event_types where code in ('project.updated', 'project.archived',
  'project.restored', 'project.member_ended', 'scope_node.created', 'scope_node.updated', 'scope_node.removed',
  'gate.evidence_withdrawn')), 'the eight project event types are catalogued');

-- Project creation ----------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$insert into world values ('prj_c', app.create_project((select id from world where key = 'org_a'),
  'cpr', 'Carol Pier Revue', 'America/New_York', 'US-FL-MIAMI-DADE', null, '05', (select id from world where key = 'venue_a')))$$,
  'a Manager creates a project through the RPC');
select is((select project_key from app.projects where id = pg_temp.id('prj_c')), 'CPR', 'the key is stored in capitals');
select is((select project_state::text || ' ' || current_phase_code from app.projects where id = pg_temp.id('prj_c')),
  'Proposed SCP', 'a new project starts Proposed at Scope');
select results_eq($$select scope_kind::text, scope_code, name, path::text from app.scope_nodes where project_id = (select id from world where key = 'prj_c')$$,
  $$values ('Engagement Root', 'CPR-E01', 'Carol Pier Revue', 'CPR_E01')$$,
  'the project is created with its engagement root, coded after the project key');
select is((select venue_id from app.scope_nodes where project_id = pg_temp.id('prj_c')), pg_temp.id('venue_a'),
  'the root takes the project venue');
select pg_temp.as_platform();
select is(pg_temp.events('project.created', pg_temp.id('prj_c')), 1, 'creation emits project.created once');
select is((select count(*)::int from app.domain_events where event_type = 'scope_node.created' and project_id = pg_temp.id('prj_c')),
  1, 'the root emits scope_node.created');
select pg_temp.as_user('carol');

select throws_ok($$select app.create_project((select id from world where key = 'org_a'), 'NWL', 'Duplicate', 'UTC')$$,
  '23505', null, 'a key already used in the org is refused');
select throws_ok($$select app.create_project((select id from world where key = 'org_a'), 'TZZ', 'Zone', 'Mars/Olympus')$$,
  'XR001', 'time_zone_unknown: Mars/Olympus is not an IANA time zone.', 'an unknown time zone is refused');
select throws_ok($$select app.create_project((select id from world where key = 'org_a'), 'N1', 'Digits', 'UTC')$$,
  '23514', null, 'a key with digits is refused');
select throws_ok($$select app.create_project((select id from world where key = 'org_a'), 'XVN', 'Cross venue', 'UTC',
  null, null, null, (select id from world where key = 'venue_b'))$$,
  'XR001', null, 'a venue of another org is refused');

select pg_temp.as_user('dave');
select throws_ok($$select app.create_project((select id from world where key = 'org_a'), 'DVP', 'Dave Project', 'UTC')$$,
  '42501', null, 'a Member cannot create a project');
select pg_temp.as_user('xavier');
select throws_ok($$select app.create_project((select id from world where key = 'org_a'), 'XAV', 'Cross tenant', 'UTC')$$,
  '42501', null, 'an owner of another org cannot create a project in this org');
select pg_temp.as_anon();
select throws_ok($$select app.create_project(gen_random_uuid(), 'ANN', 'Anon', 'UTC')$$, '42501', null,
  'anon cannot create a project');
select pg_temp.as_platform();
select is((select count(*)::int from app.projects where project_key in ('DVP', 'XAV', 'ANN', 'TZZ', 'XVN')), 0,
  'refused creations leave no project behind');
select is((select count(*)::int from app.projects p where p.deleted_at is null
  and not exists (select 1 from app.scope_nodes n where n.project_id = p.id and n.parent_id is null)
  and p.id = pg_temp.id('prj_c')), 0, 'no project created through the RPC lacks its root');

-- Header edits, archive and restore ------------------------------------------------------------------------
select pg_temp.as_user('alice');
update app.projects set name = 'Northwind Summer Series 2026', tier_code = '04' where id = pg_temp.id('prj_a');
select is(pg_temp.events('project.updated', pg_temp.id('prj_a')), 1, 'a header edit emits project.updated');
select is((select data -> 'changed' from app.domain_events where event_type = 'project.updated' and subject_id = pg_temp.id('prj_a')),
  '["name", "tier_code"]'::jsonb, 'project.updated names the changed columns');
update app.projects set archived_at = now() where id = pg_temp.id('prj_a2');
select is(pg_temp.events('project.archived', pg_temp.id('prj_a2')), 1, 'archiving emits project.archived');
select is(pg_temp.events('project.updated', pg_temp.id('prj_a2')), 0, 'archiving alone is not a header edit');
update app.projects set archived_at = null where id = pg_temp.id('prj_a2');
select is(pg_temp.events('project.restored', pg_temp.id('prj_a2')), 1, 'restoring emits project.restored');

-- Scope tree ---------------------------------------------------------------------------------------------------
insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name)
values (pg_temp.id('prj_a'), pg_temp.id('root_a'), 'Standing Venue', 'NWL-V01', 'Bayfront Stage');
insert into world select 'venue_node', id from app.scope_nodes where scope_code = 'NWL-V01';
insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name)
values (pg_temp.id('prj_a'), pg_temp.id('venue_node'), 'Show', 'NWL-S02', 'Closing Night');
select is(pg_temp.events('scope_node.created', pg_temp.id('venue_node')), 1, 'a new scope node emits scope_node.created');
update app.scope_nodes set name = 'Bayfront Main Stage' where id = pg_temp.id('venue_node');
select is(pg_temp.events('scope_node.updated', pg_temp.id('venue_node')), 1, 'a rename emits scope_node.updated');
select throws_ok($$update app.scope_nodes set deleted_at = now() where id = (select id from world where key = 'root_a')$$,
  'XR001', 'scope_root_retained: The engagement root stays while the project exists.', 'the engagement root cannot be removed');
select throws_ok($$update app.scope_nodes set deleted_at = now() where id = (select id from world where key = 'venue_node')$$,
  'XR001', 'scope_node_has_children: Remove the nodes beneath this node first.', 'a node with live children cannot be removed');
select lives_ok($$update app.scope_nodes set deleted_at = now() where id = (select id from world where key = 'show_a')$$,
  'a leaf node is removed');
select is(pg_temp.events('scope_node.removed', pg_temp.id('show_a')), 1, 'removal emits scope_node.removed');

-- Evidence withdrawal and members ending --------------------------------------------------------------------------
insert into app.gate_evidence (project_id, criterion_id, evidence_uri, assertion_rank)
values (pg_temp.id('prj_a'), 'G1.GONOGO', 'https://docs.example.com/go-no-go.pdf', 4);
insert into world select 'evidence_a', id from app.gate_evidence where evidence_uri = 'https://docs.example.com/go-no-go.pdf';
update app.gate_evidence set deleted_at = now() where id = pg_temp.id('evidence_a');
select is(pg_temp.events('gate.evidence_withdrawn', pg_temp.id('evidence_a')), 1, 'withdrawing evidence emits gate.evidence_withdrawn');
update app.project_members set valid_to = now() where project_id = pg_temp.id('prj_a') and membership_id = pg_temp.id('frank@org_a');
select is((select count(*)::int from app.domain_events where event_type = 'project.member_ended' and project_id = pg_temp.id('prj_a')),
  1, 'ending a project membership emits project.member_ended');
select pg_temp.as_platform();

-- Activity feed -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select ok(pg_temp.feed_types('org_a') @> array['project.created', 'project.updated', 'scope_node.removed', 'gate.evidence_withdrawn'],
  'the owner reads the org feed with project events');
select is((select actor_name from app.activity_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'), null, 200) where event_type = 'project.updated'),
  'Alice Moreno', 'each activity names the person who caused it');
select ok(not exists (select 1 from app.activity_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'), null, 200) f
  where f.project_id is distinct from pg_temp.id('prj_a')), 'the project filter returns only that project''s events');
select is((select count(*)::int from app.activity_feed(pg_temp.id('org_a'), null, null, 3)), 3, 'the page size is honored');
select ok(not exists (select 1 from app.activity_feed(pg_temp.id('org_a'), null,
  (select min(occurred_at) from app.activity_feed(pg_temp.id('org_a'), null, null, 3)), 200) f
  where f.occurred_at >= (select min(occurred_at) from app.activity_feed(pg_temp.id('org_a'), null, null, 3))),
  'keyset paging returns only older events');

select pg_temp.as_user('dave');
select is(pg_temp.feed_projects('org_a'), array['NWL'], 'a Member reads events only of the project they belong to (invariant 2)');
select pg_temp.as_user('erin');
select is(pg_temp.feed_projects('org_a'), array['NWL'], 'a Collaborator at assigned reach reads only their project''s events');
select pg_temp.as_user('gina');
select is(pg_temp.feed_projects('org_a'), '{}'::text[], 'a Viewer in no project reads no project events');
select pg_temp.as_user('carol');
select is(pg_temp.feed_projects('org_a'), array['CPR', 'NWL', 'NWX'], 'a Manager overseeing every project reads all project events');
select pg_temp.as_user('frank');
select throws_ok($$select * from app.activity_feed((select id from world where key = 'org_a'))$$, '42501', null,
  'a Field member without activity.feed.read is refused');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.activity_feed((select id from world where key = 'org_a'))$$, '42501', null,
  'another org''s owner cannot read this org''s feed');
select pg_temp.as_user('nina');
select throws_ok($$select * from app.activity_feed((select id from world where key = 'org_a'))$$, '42501', null,
  'a person with no membership cannot read the feed');
select pg_temp.as_anon();
select throws_ok($$select * from app.activity_feed(gen_random_uuid())$$, '42501', null, 'anon cannot read the feed');
select pg_temp.as_platform();

select * from finish();
rollback;
