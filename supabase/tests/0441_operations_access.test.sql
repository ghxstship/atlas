-- pgTAP: A11 app.operations_project_capabilities (migration 0441). It reports exactly the
-- capabilities the invariant 2 rule grants: assigned reach only on the person's projects, org reach
-- with oversight everywhere, nothing in another org and nothing for anon.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(7);

select pg_temp.as_user('dave');
select ok(exists (select 1 from app.operations_project_capabilities(pg_temp.id('org_a'))
  where project_id = pg_temp.id('prj_a') and capability_code = 'logistics.shipment.write'),
  'a Member may write shipments on their project');
select ok(not exists (select 1 from app.operations_project_capabilities(pg_temp.id('org_a'))
  where project_id = pg_temp.id('prj_a2')),
  'and has nothing on a project they are not a member of');
select pg_temp.as_user('frank');
select ok(not exists (select 1 from app.operations_project_capabilities(pg_temp.id('org_a'))
  where capability_code = 'logistics.release.approve'),
  'a Field member never holds release authority');
select pg_temp.as_user('alice');
select is((select count(distinct project_id)::int from app.operations_project_capabilities(pg_temp.id('org_a'))
  where capability_code = 'hospitality.beo.approve'), 2, 'the Owner may approve BEOs on every project');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.operations_project_capabilities(pg_temp.id('org_a'))), 0, 'another org''s owner sees nothing in org A');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.operations_project_capabilities(pg_temp.id('org_a'))), 0, 'a Viewer outside every project holds nothing');
select pg_temp.as_anon();
select throws_ok($$select * from app.operations_project_capabilities((select id from world where key = 'org_a'))$$, '42501', null, 'anon cannot call it');

select * from finish();
rollback;
