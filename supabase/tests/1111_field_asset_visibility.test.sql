-- pgTAP: a Field member reads the asset units assigned to their project or checked out to them, and no others
-- (A42, SIM-006). The current custody decides; the scan lookup agrees with the read policy. Same-tenant
-- allow for full readers, cross-tenant deny, anon deny, API-key scopes.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(15);

-- Fixture: five radios in org_a, held in different places ---------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_a'), '9000.03.01-XPMS-003', 'Digital Two-Way Radio') returning id) insert into world select 'cls', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('cls'), 'NWL-RAD-101') returning id) insert into world select 'u_proj', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('cls'), 'NWL-RAD-102') returning id) insert into world select 'u_mine', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('cls'), 'NWL-RAD-103') returning id) insert into world select 'u_other', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('cls'), 'NWL-RAD-104') returning id) insert into world select 'u_shelf', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('cls'), 'NWL-RAD-105') returning id) insert into world select 'u_moved', id from x;
insert into app.asset_identifiers (asset_unit_id, scheme, value) values
  (pg_temp.id('u_proj'), 'gtin14', '09501101530003'),
  (pg_temp.id('u_shelf'), 'serial', 'SN-104');
-- Custody rows are fixtures written by the platform; signed-in users write custody only through the scan (R7, 2692).
select pg_temp.as_platform();
insert into app.asset_custody (asset_unit_id, venue_id, project_id, created_at) values
  (pg_temp.id('u_proj'), pg_temp.id('venue_a'), pg_temp.id('prj_a'), now() - interval '2 hours'),
  (pg_temp.id('u_other'), pg_temp.id('venue_a'), pg_temp.id('prj_a2'), now() - interval '2 hours'),
  (pg_temp.id('u_moved'), pg_temp.id('venue_a'), pg_temp.id('prj_a'), now() - interval '2 hours');
insert into app.asset_custody (asset_unit_id, custodian_membership_id) values (pg_temp.id('u_mine'), pg_temp.id('frank@org_a'));
insert into app.asset_custody (asset_unit_id, venue_id, project_id) values (pg_temp.id('u_moved'), pg_temp.id('venue_a'), pg_temp.id('prj_a2'));
select pg_temp.as_user('carol');

select is((select count(*)::int from app.asset_units where asset_class_id = pg_temp.id('cls')), 5, 'a Manager reads every unit of the org');

-- frank: Field on prj_a ------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select count(*)::int from app.asset_units where id = pg_temp.id('u_proj')), 1, 'a Field member reads a unit out for their project');
select is((select count(*)::int from app.asset_units where id = pg_temp.id('u_mine')), 1, 'and a unit checked out to them');
select is((select count(*)::int from app.asset_units where id = pg_temp.id('u_other')), 0, 'but not a unit out for a project they are not on');
select is((select count(*)::int from app.asset_units where id = pg_temp.id('u_shelf')), 0, 'nor a unit on the shelf');
select is((select count(*)::int from app.asset_units where id = pg_temp.id('u_moved')), 0, 'nor a unit that has since moved to another project: the current custody decides');
select is((select array_agg(value) from app.asset_identifiers where asset_unit_id in (select id from world where key like 'u\_%')),
  array['09501101530003'], 'identifiers follow their unit, so the GTIN of the project''s unit resolves on the device');
select is((select subject_kind || ' ' || asset_tag from app.resolve_asset_code(pg_temp.id('org_a'), '09501101530003')), 'unit NWL-RAD-101',
  'the scan lookup resolves the project''s unit by its GTIN');
select is((select subject_kind from app.resolve_asset_code(pg_temp.id('org_a'), 'NWL-RAD-102')), 'unit', 'and the unit checked out to them by its tag');
select is((select reason from app.resolve_asset_code(pg_temp.id('org_a'), 'NWL-RAD-104')), 'asset_code_unknown',
  'a unit they may not see stays unknown to the lookup as well');

-- API-key scopes, other org, anon --------------------------------------------------------------------------------
select pg_temp.as_platform();
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('frank_user'), 'role', 'authenticated', 'scopes', json_build_array('crew'),
  'amr', json_build_array(json_build_object('method', 'xos_api_key', 'timestamp', 0)))::text, true);
select is(private.asset_unit_assigned_to_me(pg_temp.id('u_mine')), false, 'an API key without the assets scope reaches no assigned unit (A22-001)');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.asset_units where asset_class_id = pg_temp.id('cls')), 0, 'another org reads none of the units');
select is((select count(*)::int from app.asset_identifiers where asset_unit_id = pg_temp.id('u_proj')), 0, 'nor their identifiers');
select pg_temp.as_anon();
select throws_ok('select 1 from app.asset_units', '42501', null, 'anon cannot read asset units');
select pg_temp.as_platform();
select is((select prosecdef from pg_proc where oid = 'private.asset_unit_assigned_to_me(uuid)'::regprocedure), true,
  'the helper runs as definer and takes the unit id as its argument (ADR 0016 item 14)');

select * from finish();
rollback;
