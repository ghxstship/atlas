-- pgTAP: migration 1205, cross-org project shares (A52, Section 8.5). An Admin shares a project with a partner org; the
-- partner's members read the share, the project projection and the shared scope nodes but never the owner's project row,
-- and hold the share's project role on the project; revoking ends all of it. Both audit ledgers record the share. A
-- Manager cannot share, a project is never shared with its own org and shared nodes belong to the project. Orgs outside the
-- share and anon see nothing.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(22);

select has_table('app', 'project_shares', 'app.project_shares exists');
select has_table('app', 'project_share_scope_nodes', 'app.project_share_scope_nodes exists');

select pg_temp.as_user('carol');
select throws_ok($$insert into app.project_shares (project_id, partner_organization_id) values ((select id from world where key = 'prj_a'), (select id from world where key = 'org_p'))$$,
  '42501', null, 'a Manager cannot share a project');

select pg_temp.as_user('bob');
select throws_ok($$insert into app.project_shares (project_id, partner_organization_id) values ((select id from world where key = 'prj_a'), (select id from world where key = 'org_a'))$$,
  'XR001', 'project_share_own_org: A project is shared with another organization, never its own.', 'a project is never shared with its own org');
with s as (insert into app.project_shares (project_id, partner_organization_id, project_role)
  values (pg_temp.id('prj_a'), pg_temp.id('org_p'), 'Field Supervisor') returning id)
insert into world select 'share', id from s;
select is((select org_id from app.project_shares where id = pg_temp.id('share')), pg_temp.id('org_a'), 'an Admin shares prj_a; the owning org comes from the project');
select throws_ok($$insert into app.project_shares (project_id, partner_organization_id) values ((select id from world where key = 'prj_a'), (select id from world where key = 'org_p'))$$,
  '23505', null, 'a project is shared once with each partner');
select throws_ok($$insert into app.project_share_scope_nodes (project_share_id, scope_node_id) values ((select id from world where key = 'share'), (select id from world where key = 'root_a2'))$$,
  'XR001', 'project_share_scope_project: A shared scope node belongs to the shared project.', 'a shared node belongs to the shared project');

-- The partner.
select pg_temp.as_user('paul');
select is((select count(*)::int from app.project_shares where id = pg_temp.id('share')), 1, 'the partner''s Owner reads the share');
select is((select count(*)::int from app.projects where id = pg_temp.id('prj_a')), 0, 'but never the owner''s project row');
select results_eq($$select project_key, name, project_role::text from app.shared_projects()$$,
  $$values ('NWL', 'Northwind Summer Series', 'Field Supervisor')$$, 'the project projection names the project and the role the share grants');
select is((select count(*)::int from app.shared_project_scope_nodes((select id from world where key = 'prj_a'))), 2,
  'a share without listed nodes opens the whole scope tree');
select pg_temp.claims('paul');
select is(private.can_on_project(pg_temp.id('prj_a'), 'safety.incident.dispatch'), true, 'the share''s project role reaches the shared project');
select is(private.can_on_project(pg_temp.id('prj_a'), 'projects.project.write'), false, 'and nothing beyond what that role adds');

select pg_temp.as_user('bob');
insert into app.project_share_scope_nodes (project_share_id, scope_node_id) values (pg_temp.id('share'), pg_temp.id('show_a'));
select pg_temp.as_user('paul');
select results_eq($$select scope_code from app.shared_project_scope_nodes((select id from world where key = 'prj_a'))$$,
  $$values ('NWL-E01')$$, 'listing a node narrows the share to that node and what is under it');

select pg_temp.as_user('xavier');
select is((select count(*)::int from app.shared_projects()), 0, 'an org outside the share sees no shared project');
select is((select count(*)::int from app.project_shares), 0, 'nor the share');

select pg_temp.as_platform();
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_p') and action = 'project_shares.granted'
  and subject_id = pg_temp.id('share')), 1, 'the partner''s ledger records the share');
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_a') and action = 'project_shares.insert'
  and subject_id = pg_temp.id('share')), 1, 'and so does the owner''s');

-- Revoke.
select pg_temp.as_user('bob');
update app.project_shares set deleted_at = now() where id = pg_temp.id('share');
select pg_temp.as_user('paul');
select is((select count(*)::int from app.shared_projects()), 0, 'once revoked the partner reads nothing');
select pg_temp.claims('paul');
select is(private.can_on_project(pg_temp.id('prj_a'), 'safety.incident.dispatch'), false, 'and holds no project role');
select pg_temp.as_platform();
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_p') and action = 'project_shares.revoked'), 1,
  'the partner''s ledger records the revocation');

select pg_temp.as_anon();
select throws_ok('select 1 from app.project_shares', '42501', null, 'anon reads no shares');

select * from finish();
rollback;
