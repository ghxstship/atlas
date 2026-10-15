-- pgTAP: A12 late slot 0976. A scan event replayed from a Compass offline queue through
-- app.apply_sync_mutation is applied once; a refused scan is stored as a refusal; asset classes,
-- lots, maintenance and damage are comment subjects.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(7);

select pg_temp.as_user('carol');
with x as (insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_a'), '9000.03.01-XPMS-003', 'Digital Two-Way Radio') returning id) insert into world select 'cls', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('cls'), 'NWL-SYNC-001') returning id) insert into world select 'u', id from x;
select app.transition_asset(pg_temp.id('u'), 'Proposed', 'Received', 'Delivered.');
select app.transition_asset(pg_temp.id('u'), 'Received', 'Available', 'Shelved.');
insert into world values
  ('m1', '01920000-0000-7000-8450-000000000101'), ('e1', '01920000-0000-7000-8450-000000000201'),
  ('m2', '01920000-0000-7000-8450-000000000102'), ('e2', '01920000-0000-7000-8450-000000000202');

select ok(exists (select 1 from app.sync_rpcs where rpc = 'app.apply_asset_scan'), 'apply_asset_scan is allowlisted for offline replay');
select is(
  (app.apply_sync_mutation(pg_temp.id('m1'), pg_temp.id('org_a'), 'device-1', 'app.apply_asset_scan',
    jsonb_build_object('p_event_id', pg_temp.id('e1'), 'p_org_id', pg_temp.id('org_a'), 'p_code', 'NWL-SYNC-001',
      'p_action', 'check-out', 'p_custodian_membership_id', pg_temp.id('frank@org_a'), 'p_project_id', pg_temp.id('prj_a')))
   -> 'data' -> 0 ->> 'outcome'),
  'applied', 'a queued check-out replays through the sync channel');
select is(
  (app.apply_sync_mutation(pg_temp.id('m1'), pg_temp.id('org_a'), 'device-1', 'app.apply_asset_scan',
    jsonb_build_object('p_event_id', pg_temp.id('e1'), 'p_org_id', pg_temp.id('org_a'), 'p_code', 'NWL-SYNC-001',
      'p_action', 'check-out', 'p_custodian_membership_id', pg_temp.id('frank@org_a'), 'p_project_id', pg_temp.id('prj_a')))
   -> 'data' -> 0 ->> 'outcome'),
  'applied', 'a repeated mutation id returns its stored result');
select is((select count(*)::int from app.asset_custody where asset_unit_id = pg_temp.id('u')), 1, 'and writes once');
select is(
  (app.apply_sync_mutation(pg_temp.id('m2'), pg_temp.id('org_a'), 'device-1', 'app.apply_asset_scan',
    jsonb_build_object('p_event_id', pg_temp.id('e2'), 'p_org_id', pg_temp.id('org_a'), 'p_code', 'NWL-SYNC-001',
      'p_action', 'check-out', 'p_custodian_membership_id', pg_temp.id('dave@org_a')))
   -> 'refusal' ->> 'rule'),
  'asset_scan_state_conflict', 'a stale offline scan is stored as the refusal the device shows');
select is((select count(*)::int from app.asset_custody where asset_unit_id = pg_temp.id('u')), 1, 'and changes nothing');
select is((select count(*)::int from app.comment_subjects where table_name in ('app.asset_classes', 'app.asset_lots', 'app.asset_maintenance', 'app.asset_damage', 'app.asset_units')), 5,
  'every asset grain and report carries comments and attachments');

select * from finish();
rollback;
