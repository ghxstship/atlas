-- pgTAP: A12 assets range 0450. The lot movement ledger (derived on hand, never below zero, fixed
-- opening count, append-only, written only through RPCs), recounts, code lookup (tag, identifier,
-- GTIN padding, lot label, ambiguity and unknown codes as refusals), domain events for maintenance,
-- damage and lot moves, same-tenant allow, cross-tenant deny, anon deny and role bands.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(30);

select pg_temp.as_user('carol');
with x as (insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_a'), '5000.05.03-XPMS-001', 'Box Truss 12 in') returning id) insert into world select 'cls', id from x;
with x as (insert into app.asset_lots (asset_class_id, venue_id, quantity) values (pg_temp.id('cls'), pg_temp.id('venue_a'), 10) returning id) insert into world select 'lot', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('cls'), 'NWL-TRS-001') returning id) insert into world select 'u1', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('cls'), 'NWL-TRS-002') returning id) insert into world select 'u2', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('cls'), 'NWL-TRS-003') returning id) insert into world select 'u3', id from x;
insert into app.asset_identifiers (asset_unit_id, scheme, value) values
  (pg_temp.id('u1'), 'gtin14', '00012345678905'),
  (pg_temp.id('u2'), 'serial', 'SN-77'),
  (pg_temp.id('u3'), 'mpn', 'SN-77');

-- Lot ledger -------------------------------------------------------------------------------------------------
select is((select on_hand from app.asset_lot_balances where asset_lot_id = pg_temp.id('lot')), 10::numeric, 'a new lot has its opening count on hand');
select throws_ok($$update app.asset_lots set quantity = 12 where id = (select id from world where key = 'lot')$$,
  'XR001', 'asset_lot_quantity_ledger: A lot quantity changes through a count or a movement, not an edit.', 'the opening count is fixed');
select isnt((select app.count_asset_lot(pg_temp.id('lot'), 8, 'Two sections bent.')), null, 'a recount records a movement');
select is((select delta from app.asset_lot_movements where asset_lot_id = pg_temp.id('lot')), -2::numeric, 'the recount moves the difference');
select is((select movement_kind::text from app.asset_lot_movements where asset_lot_id = pg_temp.id('lot')), 'Count', 'as a Count movement');
select is((select on_hand from app.asset_lot_balances where asset_lot_id = pg_temp.id('lot')), 8::numeric, 'on hand follows the ledger');
select is((select app.count_asset_lot(pg_temp.id('lot'), 8)), null, 'a count that matches records nothing');
select throws_ok($$select app.count_asset_lot((select id from world where key = 'lot'), -1)$$, 'XR001', null, 'a count is never negative');
select throws_ok($$insert into app.asset_lot_movements (asset_lot_id, movement_kind, delta) values ((select id from world where key = 'lot'), 'Count', 1)$$,
  '42501', null, 'signed-in callers write the lot ledger only through its RPCs');
select throws_ok($$update app.asset_lot_movements set note = 'Edited.'$$, '42501', null, 'the lot ledger is append-only');

select pg_temp.as_user('dave');
select throws_ok($$select app.count_asset_lot((select id from world where key = 'lot'), 3)$$, '42501', null, 'a Member cannot recount org-wide');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.asset_lot_movements), 1, 'a Viewer reads the lot ledger');
select is((select on_hand from app.asset_lot_balances where asset_lot_id = pg_temp.id('lot')), 8::numeric, 'and the balance');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.asset_lot_movements), 0, 'another org reads no lot movements');
select is((select count(*)::int from app.asset_lot_balances), 0, 'nor balances');
select pg_temp.as_anon();
select throws_ok('select 1 from app.asset_lot_movements', '42501', null, 'anon cannot read the lot ledger');

select pg_temp.as_platform();
select throws_ok($$insert into app.asset_lot_movements (asset_lot_id, movement_kind, delta) values ((select id from world where key = 'lot'), 'Count', -9)$$,
  'XR001', 'asset_lot_insufficient: Only 8 are on hand in this lot.', 'a movement never takes a lot below zero');
select throws_ok($$insert into app.asset_lot_movements (asset_lot_id, movement_kind, delta, custodian_membership_id) values ((select id from world where key = 'lot'), 'Check Out', 2, (select id from world where key = 'dave@org_a'))$$,
  '23514', null, 'a check-out moves a negative quantity');
select throws_ok($$insert into app.asset_lot_movements (asset_lot_id, movement_kind, delta) values ((select id from world where key = 'lot'), 'Check Out', -2)$$,
  '23514', null, 'a check-out names who takes it');

-- Code lookup ------------------------------------------------------------------------------------------------
select is((select o_unit_id from private.find_asset_code(pg_temp.id('org_a'), ' nwl-trs-001 ')), pg_temp.id('u1'), 'an asset tag resolves trimmed and uppercased');
select is((select o_unit_id from private.find_asset_code(pg_temp.id('org_a'), '012345678905')), pg_temp.id('u1'), 'a GTIN-12 resolves as GTIN-14');
select is((select o_rule from private.find_asset_code(pg_temp.id('org_a'), 'SN-77')), 'asset_code_ambiguous', 'an identifier two units carry is refused, never guessed');
select is((select o_rule from private.find_asset_code(pg_temp.id('org_a'), 'NOPE-404')), 'asset_code_unknown', 'an unknown code is refused');
select is((select o_lot_id from private.find_asset_code(pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'))), pg_temp.id('lot'), 'a lot label resolves to its lot');
select is((select o_rule from private.find_asset_code(pg_temp.id('org_b'), 'NWL-TRS-001')), 'asset_code_unknown', 'a code never resolves in another org');

-- Domain events ----------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.asset_maintenance (asset_unit_id, performed_on, description) values (pg_temp.id('u1'), current_date, 'Pins replaced.');
insert into app.asset_damage (asset_unit_id, project_id, description) values (pg_temp.id('u2'), pg_temp.id('prj_a'), 'Chord dented on load-out.');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'asset.lot_moved' and subject_id = pg_temp.id('lot')), 1, 'a lot move emits asset.lot_moved');
select is((select count(*)::int from app.domain_events where event_type = 'asset.maintenance_recorded' and subject_id = pg_temp.id('u1')), 1, 'maintenance emits asset.maintenance_recorded');
select is((select data ->> 'cost_minor' from app.domain_events where event_type = 'asset.maintenance_recorded' and subject_id = pg_temp.id('u1')), null, 'an unknown cost stays null in the event');
select is((select count(*)::int from app.domain_events where event_type = 'asset.damage_reported' and subject_id = pg_temp.id('u2')), 1, 'damage emits asset.damage_reported');
select is((select (data ->> 'project_id')::uuid from app.domain_events where event_type = 'asset.damage_reported' and subject_id = pg_temp.id('u2')), pg_temp.id('prj_a'), 'naming the project');

select * from finish();
rollback;
