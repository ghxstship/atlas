-- pgTAP: A12 assets late slot 0975. Custody to an engagement (one custodian, never both; cross-org
-- refused; the engaged person reads their own custody), and the Compass scan RPCs: resolution with
-- NO_ANSWER rows, check-out and check-in with the state move, replays that change nothing, event ids
-- reused on another subject, server-wins state conflicts, unavailable states, project reach for
-- field crew, external parties resolving only the gear they hold, lot scans through the lot ledger,
-- same-tenant allow, cross-tenant deny and anon deny.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(41);

select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');

select pg_temp.as_user('carol');
with x as (insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_a'), '9000.03.01-XPMS-003', 'Digital Two-Way Radio') returning id) insert into world select 'cls', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag, home_venue_id) values (pg_temp.id('cls'), 'NWL-RAD-001', pg_temp.id('venue_a')) returning id) insert into world select 'r1', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag, home_venue_id) values (pg_temp.id('cls'), 'NWL-RAD-002', pg_temp.id('venue_a')) returning id) insert into world select 'r2', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('cls'), 'NWL-RAD-003') returning id) insert into world select 'r3', id from x;
with x as (insert into app.asset_lots (asset_class_id, venue_id, quantity) values (pg_temp.id('cls'), pg_temp.id('venue_a'), 20) returning id) insert into world select 'lot', id from x;
select app.transition_asset(pg_temp.id(k), 'Proposed', 'Received', 'Delivered.') from (values ('r1'), ('r2'), ('r3')) v(k);
select app.transition_asset(pg_temp.id(k), 'Received', 'Available', 'Shelved.') from (values ('r1'), ('r2'), ('r3')) v(k);
insert into world values
  ('ev1', '01920000-0000-7000-8450-000000000001'), ('ev2', '01920000-0000-7000-8450-000000000002'),
  ('ev3', '01920000-0000-7000-8450-000000000003'), ('ev4', '01920000-0000-7000-8450-000000000004'),
  ('ev5', '01920000-0000-7000-8450-000000000005'), ('ev6', '01920000-0000-7000-8450-000000000006'),
  ('ev7', '01920000-0000-7000-8450-000000000007'), ('ev8', '01920000-0000-7000-8450-000000000008');

-- Custody to an engagement -------------------------------------------------------------------------------------
-- The constraints hold for the platform; signed-in users write custody only through the scan RPCs (R7, 2692).
select pg_temp.as_platform();
select throws_ok($$insert into app.asset_custody (asset_unit_id, custodian_membership_id, custodian_engagement_id) values ((select id from world where key = 'r3'), (select id from world where key = 'dave@org_a'), (select id from world where key = 'eng_ivy_a'))$$,
  '23514', null, 'custody goes to a membership or an engagement, never both');
select throws_ok($$insert into app.asset_custody (asset_unit_id, custodian_engagement_id) values ((select id from world where key = 'r3'), (select id from world where key = 'eng_ivy_b'))$$,
  'XR001', null, 'custody never goes to another org''s engagement');
select lives_ok($$insert into app.asset_custody (asset_unit_id, custodian_engagement_id, project_id) values ((select id from world where key = 'r3'), (select id from world where key = 'eng_ivy_a'), (select id from world where key = 'prj_a'))$$,
  'custody goes to an engagement alone');
select pg_temp.as_user('carol');

-- Resolution and check-out by a Manager ----------------------------------------------------------------------
select is((select subject_kind from app.resolve_asset_code(pg_temp.id('org_a'), 'nwl-rad-001')), 'unit', 'a Manager resolves a tag');
select is((select asset_state::text from app.resolve_asset_code(pg_temp.id('org_a'), 'NWL-RAD-001')), 'Available', 'with its state');
select is((select reason from app.resolve_asset_code(pg_temp.id('org_a'), 'NOPE-1')), 'asset_code_unknown', 'an unknown code returns a NO_ANSWER row');
select is((select refusal from app.resolve_asset_code(pg_temp.id('org_a'), 'NOPE-1')), 'NO_ANSWER', 'never a guess');
select is((select on_hand from app.resolve_asset_code(pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'))), 20::numeric, 'a lot label resolves with its quantity on hand');

select is((select outcome || ' ' || asset_state from app.apply_asset_scan(pg_temp.id('ev1'), pg_temp.id('org_a'), 'NWL-RAD-001', 'check-out', pg_temp.id('frank@org_a'), null, null, pg_temp.id('prj_a'))),
  'applied Deployed', 'a check-out scan hands the unit over and deploys it');
select is((select count(*)::int from app.asset_custody where id = pg_temp.id('ev1')), 1, 'the custody row carries the device event id');
select is((select reason from app.asset_state_transitions where asset_unit_id = pg_temp.id('r1') order by created_at desc, id desc limit 1), 'Checked out by scan.', 'the state move is logged');
select is((select outcome || ' ' || asset_state from app.apply_asset_scan(pg_temp.id('ev1'), pg_temp.id('org_a'), 'NWL-RAD-001', 'check-out', pg_temp.id('frank@org_a'), null, null, pg_temp.id('prj_a'))),
  'duplicate Deployed', 'a replayed event answers duplicate');
select is((select count(*)::int from app.asset_custody where asset_unit_id = pg_temp.id('r1')), 1, 'and writes no second custody row');
select is((select count(*)::int from app.asset_state_transitions where asset_unit_id = pg_temp.id('r1')), 4, 'and no second state move');
select throws_ok($$select * from app.apply_asset_scan((select id from world where key = 'ev2'), (select id from world where key = 'org_a'), 'NWL-RAD-001', 'check-out', (select id from world where key = 'dave@org_a'))$$,
  'XR001', 'asset_scan_state_conflict: The asset is Deployed now; refresh before you scan again.', 'the server wins a stale check-out');
select throws_ok($$select * from app.apply_asset_scan((select id from world where key = 'ev1'), (select id from world where key = 'org_a'), 'NWL-RAD-002', 'check-out', (select id from world where key = 'dave@org_a'))$$,
  'XR001', null, 'an event id never moves a second asset');
select throws_ok($$select * from app.apply_asset_scan((select id from world where key = 'ev2'), (select id from world where key = 'org_a'), 'NOPE-1', 'check-out', (select id from world where key = 'dave@org_a'))$$,
  'XR001', null, 'an unknown code is refused');
select throws_ok($$select * from app.apply_asset_scan((select id from world where key = 'ev2'), (select id from world where key = 'org_a'), 'NWL-RAD-002', 'check-out')$$,
  'XR001', 'asset_scan_custodian_required: Name the one member or engagement that takes the asset.', 'a check-out names who takes it');
select throws_ok($$select * from app.apply_asset_scan((select id from world where key = 'ev2'), (select id from world where key = 'org_a'), 'NWL-RAD-002', 'check-out', (select id from world where key = 'dave@org_a'), (select id from world where key = 'eng_ivy_a'))$$,
  'XR001', null, 'and never two custodians');
select throws_ok($$select * from app.apply_asset_scan((select id from world where key = 'ev2'), (select id from world where key = 'org_a'), 'NWL-RAD-002', 'transfer', (select id from world where key = 'dave@org_a'))$$,
  'XR001', null, 'only a deployed asset transfers');

-- Field crew on their project ---------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select subject_kind from app.resolve_asset_code(pg_temp.id('org_a'), 'NWL-RAD-001')), 'unit', 'field crew with project custody resolve a tag');
select is((select outcome || ' ' || asset_state from app.apply_asset_scan(pg_temp.id('ev3'), pg_temp.id('org_a'), 'NWL-RAD-001', 'check-in')),
  'applied Available', 'field crew check in gear out for their project');
select throws_ok($$select * from app.apply_asset_scan((select id from world where key = 'ev4'), (select id from world where key = 'org_a'), 'NWL-RAD-001', 'check-out', (select id from world where key = 'frank@org_a'), null, null, (select id from world where key = 'prj_a2'))$$,
  '42501', null, 'but not for a project they are not on');
select is((select outcome from app.apply_asset_scan(pg_temp.id('ev4'), pg_temp.id('org_a'), 'NWL-RAD-001', 'check-out', pg_temp.id('frank@org_a'), null, null, pg_temp.id('prj_a'))),
  'applied', 'and check out for their own project');

-- Checking in to the home venue --------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select venue_id from app.asset_custody where id = pg_temp.id('ev3')), pg_temp.id('venue_a'), 'a check-in without a place returns the unit home');
select lives_ok($$select app.transition_asset((select id from world where key = 'r2'), 'Available', 'In Maintenance', 'Battery swap.')$$, 'a unit goes in for maintenance');
select throws_ok($$select * from app.apply_asset_scan((select id from world where key = 'ev5'), (select id from world where key = 'org_a'), 'NWL-RAD-002', 'check-out', (select id from world where key = 'dave@org_a'))$$,
  'XR001', 'asset_scan_unavailable: The asset is In Maintenance and cannot move by scan.', 'a unit in maintenance cannot move by scan');

-- External crew -----------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select is((select subject_kind from app.resolve_asset_code(pg_temp.id('org_a'), 'NWL-RAD-003')), 'unit', 'engaged crew resolve the gear they hold');
select is((select custodian_engagement_id from app.resolve_asset_code(pg_temp.id('org_a'), 'NWL-RAD-003')), pg_temp.id('eng_ivy_a'), 'held through their engagement');
select is((select reason from app.resolve_asset_code(pg_temp.id('org_a'), 'NWL-RAD-001')), 'asset_code_unknown', 'and nothing else');
select is((select reason from app.resolve_asset_code(pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'))), 'asset_code_unknown', 'not even lots');
select is((select count(*)::int from app.asset_custody), 1, 'engaged crew read only their own custody rows');
select throws_ok($$select * from app.apply_asset_scan((select id from world where key = 'ev6'), (select id from world where key = 'org_a'), 'NWL-RAD-003', 'transfer', (select id from world where key = 'dave@org_a'))$$,
  '42501', null, 'engaged crew do not move gear by scan');
select pg_temp.as_user('quinn');
select throws_ok($$select * from app.resolve_asset_code((select id from world where key = 'org_a'), 'NWL-RAD-003')$$, '42501', null, 'another org''s crew cannot scan here');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.resolve_asset_code((select id from world where key = 'org_a'), 'NWL-RAD-001')$$, '42501', null, 'another org cannot scan here');
select pg_temp.as_anon();
select throws_ok($$select * from app.resolve_asset_code((select id from world where key = 'org_a'), 'NWL-RAD-001')$$, '42501', null, 'anon cannot scan');

-- Lots through the ledger -------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select on_hand from app.apply_asset_scan(pg_temp.id('ev6'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), 'check-out', pg_temp.id('dave@org_a'), null, null, pg_temp.id('prj_a'), null, 5)),
  15::numeric, 'a lot check-out moves the quantity through the ledger');
select is((select outcome || ' ' || on_hand from app.apply_asset_scan(pg_temp.id('ev6'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), 'check-out', pg_temp.id('dave@org_a'), null, null, pg_temp.id('prj_a'), null, 5)),
  'duplicate 15', 'a replayed lot event changes nothing');
select throws_ok(format($$select * from app.apply_asset_scan(%L, %L, %L, 'check-out', %L, null, null, null, null, 100)$$, pg_temp.id('ev7'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), pg_temp.id('dave@org_a')),
  'XR001', 'asset_lot_insufficient: Only 15 are on hand in this lot.', 'a lot check-out never takes more than is on hand');
select throws_ok(format($$select * from app.apply_asset_scan(%L, %L, %L, 'check-out', %L)$$, pg_temp.id('ev7'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), pg_temp.id('dave@org_a')),
  'XR001', 'asset_scan_quantity_required: Say how many of the lot move.', 'a lot scan says how many');

select pg_temp.as_platform();
select ok((select data ? 'custodian_engagement_id' from app.domain_events where event_type = 'asset.custody_changed' and subject_id = pg_temp.id('r3') limit 1), 'custody events name the engagement');

select * from finish();
rollback;
