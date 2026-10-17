-- pgTAP: Access transparency (Section 8.4, A36). View as role never shows more than the viewer holds,
-- and Why can I see this explains only records the caller can read, naming the membership, project
-- membership, grants and policy behind them.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(18);

-- View as role ---------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select ok((select count(*) from app.view_as_capabilities(pg_temp.id('org_a'), pg_temp.system_role('field'))) > 0,
  'an Admin previews the Field role');
select is((select count(*)::int from app.view_as_capabilities(pg_temp.id('org_a'), pg_temp.system_role('field'))
           where preview_reach > viewer_reach or (viewer_reach is null and preview_reach is not null)), 0,
  'no previewed capability exceeds the Admin''s own reach');
select is((select count(*)::int from app.view_as_capabilities(pg_temp.id('org_a'), pg_temp.system_role('owner'))
           where preview_reach is not null and viewer_reach is null), 0,
  'previewing the Owner adds nothing the Admin lacks');
select ok((select count(*) from app.view_as_capabilities(pg_temp.id('org_a'), pg_temp.system_role('owner')) where capability_code = 'org.organization.delete' and preview_reach is null) = 1,
  'an Owner-only capability stays out of the Admin''s preview');
select is((select preview_reach::text from app.view_as_capabilities(pg_temp.id('org_a'), pg_temp.system_role('field'))
           where capability_code = 'crew.time.write'), (select rc.reach::text from app.role_capabilities rc
           where rc.role_id = pg_temp.system_role('field') and rc.capability_code = 'crew.time.write'),
  'a Field capability the Admin holds more widely previews at the Field reach');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.view_as_capabilities((select id from world where key = 'org_a'), pg_temp.system_role('field'))$$,
  '42501', null, 'a Member cannot use View as role');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.view_as_capabilities((select id from world where key = 'org_a'), pg_temp.system_role('field'))$$,
  '42501', null, 'nor can another org''s Owner');
select pg_temp.as_user('alice');
select throws_ok($$select * from app.view_as_capabilities((select id from world where key = 'org_a'), gen_random_uuid())$$,
  'XR001', 'view_as_role_unknown: Preview a platform role or one of this org''s roles.', 'an unknown role is refused');
select pg_temp.as_anon();
select throws_ok($$select * from app.view_as_capabilities(gen_random_uuid(), gen_random_uuid())$$, '42501', null, 'anon cannot preview');

-- Why can I see this ---------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select label from app.explain_access('projects', pg_temp.id('prj_a')) where path_kind = 'Project Membership'),
  'NWL Northwind Summer Series', 'a project member is told about the project membership');
select is((select detail from app.explain_access('projects', pg_temp.id('prj_a')) where path_kind = 'Membership'),
  'member', 'and the org membership with its role');
select is((select label from app.explain_access('projects', pg_temp.id('prj_a')) where path_kind = 'Policy'),
  'projects_read', 'and the read policy that admitted the record');
select throws_ok($$select * from app.explain_access('projects', (select id from world where key = 'prj_a2'))$$,
  '42501', null, 'a project the Member cannot read is not explained');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.explain_access('projects', pg_temp.id('prj_a2')) where path_kind = 'Project Membership'), 0,
  'the Owner reads a project she is not a member of through her role, not a project membership');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.explain_access('venues', (select id from world where key = 'venue_a'))$$,
  '42501', null, 'another org''s record is not found');
select throws_ok($$select * from app.explain_access('organizations; drop table app.venues', gen_random_uuid())$$,
  'XR001', 'explain_table_unknown: Only records of tenant tables are explained.', 'only tenant table names are accepted');

-- A record grant to another org is named ---------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.record_grants (target_kind, target_id, capability_code, grantee_org_id, valid_from, valid_to, reason)
values ('project', pg_temp.id('prj_a'), 'projects.project.read', pg_temp.id('org_b'), now(), now() + interval '1 day', 'Co-production review.');
select pg_temp.as_user('xavier');
select is((select detail from app.explain_access('projects', pg_temp.id('prj_a')) where path_kind = 'Record Grant'),
  'project: Co-production review.', 'a person reading through a grant to their org is told about the grant');
select pg_temp.as_anon();
select throws_ok($$select * from app.explain_access('projects', gen_random_uuid())$$, '42501', null, 'anon cannot ask');

select * from finish();
rollback;
