-- pgTAP: migration 2681 (R7a), the supply bridge. Rental order lines keep their hire period with their kind;
-- app.receive_goods brings serialized units in by tag (Received, on the receipt line) and quantities into a lot (a
-- Receipt movement), records a plain receipt line for a service, replays as duplicate and refuses every rule in
-- order; the unit receipt guard holds; app.return_goods sends units back as Returned, lot quantities out as a
-- Vendor Return movement and other quantities as a plain line, refuses a line that does not go back the way it came
-- in, and refuses every other rule; Returned is never reached through app.transition_asset; the
-- direction constraint keeps R1's engagement custodian; app.receive_goods is a sync RPC.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 2681_supply_world.psql

select * from no_plan();

insert into world values
  ('ev1', '01920000-0000-7000-8681-000000000001'), ('ev2', '01920000-0000-7000-8681-000000000002'),
  ('ev3', '01920000-0000-7000-8681-000000000003'), ('ev4', '01920000-0000-7000-8681-000000000004'),
  ('ev5', '01920000-0000-7000-8681-000000000005'), ('ev6', '01920000-0000-7000-8681-000000000006'),
  ('ev7', '01920000-0000-7000-8681-000000000007'), ('ev8', '01920000-0000-7000-8681-000000000008'),
  ('ret1', '01920000-0000-7000-8681-000000000101'), ('ret2', '01920000-0000-7000-8681-000000000102'),
  ('ret3', '01920000-0000-7000-8681-000000000103'), ('ret4', '01920000-0000-7000-8681-000000000104'),
  ('ret9', '01920000-0000-7000-8681-000000000109');

-- Rental lines ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select throws_ok(format($$insert into app.po_lines (purchase_order_id, line_number, description, quantity, acquisition_kind)
    values (%L, 2, 'A hire with no period.', 1, 'Rental')$$, pg_temp.id('po3')),
  '23514', null, 'a rental line names its hire period');
select throws_ok(format($$insert into app.po_lines (purchase_order_id, line_number, description, quantity, hire_period)
    values (%L, 2, 'A purchase with a period.', 1, '[2027-06-01,2027-06-05)')$$, pg_temp.id('po3')),
  '23514', null, 'a purchase line has no hire period');
select throws_ok(format($$insert into app.po_lines (purchase_order_id, line_number, description, quantity, acquisition_kind, hire_period)
    values (%L, 2, 'An open-ended hire.', 1, 'Rental', '[2027-06-01,)')$$, pg_temp.id('po3')),
  '23514', null, 'a hire period has both ends');
select is((select acquisition_kind::text from app.po_lines where id = pg_temp.id('l3')), 'Purchase', 'a line is a Purchase unless it says otherwise');

-- Receiving: refusals before anything is written -------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.receive_goods(null, pg_temp.id('po'), '[]'::jsonb)$$,
  'XR001', 'receipt_event_required: Every receipt carries the event id it was recorded under.', 'a receipt needs its event id');
select throws_ok($$select pg_temp.receive('ev1', 'po', '[]'::jsonb)$$,
  'XR001', 'receipt_lines_required: A receipt receives at least one line.', 'a receipt receives at least one line');
select throws_ok($$select pg_temp.receive('ev1', 'po3', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l3'), 'quantity', 1)))$$,
  'XR001', 'receipt_order_state: Goods are received only against an approved or sent purchase order.', 'a Proposed order receives nothing');
select throws_ok($$select pg_temp.receive('ev1', 'po', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l2'), 'quantity', 1)))$$,
  'XR001', 'receipt_line_order: A receipt line receives a line of the receipt''s purchase order.', 'a line of another order is refused');
select throws_ok($$select pg_temp.receive('ev1', 'po', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_radio'), 'quantity', 4,
    'asset_tags', jsonb_build_array('NWL-RNT-001', 'NWL-RNT-002', 'NWL-RNT-003', 'NWL-RNT-004'))))$$,
  'XR001', 'receipt_exceeds_order: Receipts never exceed the quantity ordered.', 'more than ordered is refused');
select throws_ok($$select pg_temp.receive('ev1', 'po', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_radio'), 'quantity', 2,
    'asset_tags', jsonb_build_array('NWL-RNT-001'))))$$,
  'XR001', 'receipt_tags_count: Give one asset tag for each unit received.', 'one tag per unit');
select throws_ok($$select pg_temp.receive('ev1', 'po', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_radio'), 'quantity', 1,
    'asset_tags', jsonb_build_array('NWL-RNT-001'), 'venue_id', pg_temp.id('venue_a'))))$$,
  'XR001', 'receipt_line_target_ambiguous: A receipt line brings units in by tag or a quantity into a lot, not both.', 'tags and a venue together are refused');
select throws_ok($$select pg_temp.receive('ev1', 'po', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_svc'), 'quantity', 1,
    'venue_id', pg_temp.id('venue_a'))))$$,
  'XR001', 'receipt_no_asset_class: The ordered item has no asset class, so it cannot come into stock.', 'an item without an asset class never comes into stock');
select pg_temp.as_user('gina');
select throws_ok($$select pg_temp.receive('ev1', 'po', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_svc'), 'quantity', 1)))$$,
  '42501', 'procurement.receipt.write is required', 'a person without procurement.receipt.write receives nothing');
select pg_temp.as_platform();
select is((select count(*)::int from app.goods_receipts where purchase_order_id in (pg_temp.id('po'), pg_temp.id('po2'), pg_temp.id('po3'))), 0,
  'no refused call left a receipt');

-- Units by tag --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select r ->> 'outcome' from pg_temp.receive('ev1', 'po', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_radio'), 'quantity', 2,
    'asset_tags', jsonb_build_array('nwl-rnt-001', ' NWL-RNT-002 ')))) r),
  'applied', 'two radios come in by tag');
insert into world select 'rl_radio', id from app.receipt_lines where goods_receipt_id = pg_temp.id('ev1');
insert into world select 'r1', id from app.asset_units where asset_tag = 'NWL-RNT-001';
insert into world select 'r2', id from app.asset_units where asset_tag = 'NWL-RNT-002';
select is((select count(*)::int from app.asset_units where receipt_line_id = pg_temp.id('rl_radio') and asset_state = 'Received'), 2,
  'one Received unit per tag, on the receipt line, tags upper-cased and trimmed');
select is((select reason from app.asset_state_transitions where asset_unit_id = pg_temp.id('r1') and to_state = 'Received'),
  format('Received on PO %s.', (select po_number from app.purchase_orders where id = pg_temp.id('po'))), 'the move names the order');
select is((select received_by from app.goods_receipts where id = pg_temp.id('ev1')), pg_temp.id('carol'), 'the receiver is the session person');
select is((select jsonb_array_length(r -> 'asset_unit_ids') from pg_temp.receive('ev1', 'po', '[]'::jsonb) r), 2,
  'a replay returns the stored units');
select is((select r ->> 'outcome' from pg_temp.receive('ev1', 'po', '[]'::jsonb) r), 'duplicate', 'and says duplicate');
select is((select count(*)::int from app.asset_units where receipt_line_id is not null), 2, 'a replay adds no unit');
select is((select count(*)::int from app.receipt_lines), 1, 'nor a receipt line');
select throws_ok($$select pg_temp.receive('ev1', 'po2', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l2'), 'quantity', 1)))$$,
  'XR001', 'receipt_event_reused: This receipt event already recorded a receipt on another purchase order.', 'an event id is never reused on another order');
select throws_ok($$select pg_temp.receive('ev2', 'po', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_radio'), 'quantity', 1,
    'asset_tags', jsonb_build_array('NWL-RNT-001'))))$$,
  'XR001', 'receipt_tag_taken: Asset tag NWL-RNT-001 is already in use.', 'a tag in use is refused');
select is((select r ->> 'outcome' from pg_temp.receive('ev2', 'po', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_radio'), 'quantity', 1,
    'asset_tags', jsonb_build_array('NWL-RNT-003')))) r),
  'applied', 'the third radio comes in on its own receipt');
insert into world select 'rl_radio3', id from app.receipt_lines where goods_receipt_id = pg_temp.id('ev2');
insert into world select 'r3', id from app.asset_units where asset_tag = 'NWL-RNT-003';

-- Quantities into a lot -------------------------------------------------------------------------------------------------------------
select is((select jsonb_array_length(r -> 'lot_movement_ids') from pg_temp.receive('ev3', 'po', jsonb_build_array(
    jsonb_build_object('po_line_id', pg_temp.id('l_deck'), 'quantity', 4, 'venue_id', pg_temp.id('venue_a')))) r),
  1, 'deck sections come into stock with one movement');
insert into world select 'rl_deck', id from app.receipt_lines where goods_receipt_id = pg_temp.id('ev3');
insert into world select 'lot', id from app.asset_lots where asset_class_id = pg_temp.id('cls_deck') and venue_id = pg_temp.id('venue_a');
select is((select movement_kind::text || ' ' || delta || ' ' || (receipt_line_id = pg_temp.id('rl_deck'))::text || ' ' || (project_id = pg_temp.id('prj_a'))::text
    from app.asset_lot_movements where asset_lot_id = pg_temp.id('lot')),
  'Receipt 4 true true', 'a Receipt movement for the quantity, on the receipt line and the order''s project');
select is((select on_hand from app.asset_lot_balances where asset_lot_id = pg_temp.id('lot')), 4::numeric, 'the lot was created at zero and rose by the quantity');
select is((select r ->> 'outcome' from pg_temp.receive('ev4', 'po', jsonb_build_array(
    jsonb_build_object('po_line_id', pg_temp.id('l_deck'), 'quantity', 3, 'venue_id', pg_temp.id('venue_a')))) r),
  'applied', 'a second delivery to the same venue');
select is((select count(*)::int from app.asset_lots where asset_class_id = pg_temp.id('cls_deck')), 1, 'reuses the lot');
select is((select on_hand from app.asset_lot_balances where asset_lot_id = pg_temp.id('lot')), 7::numeric, 'and on hand rises again');

-- A plain line ------------------------------------------------------------------------------------------------------------------------
select is((select (r -> 'asset_unit_ids') || (r -> 'lot_movement_ids') from pg_temp.receive('ev5', 'po',
    jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_svc'), 'quantity', 1))) r),
  '[]'::jsonb, 'a service records only its receipt line');
select is((select count(*)::int from app.receipt_lines where goods_receipt_id = pg_temp.id('ev5')), 1, 'one receipt line');

-- Unit creation needs assets.asset.write ----------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.user_capability_grants (org_id, membership_id, capability_code, scope_kind, scope_id, reason)
values (pg_temp.id('org_a'), pg_temp.id('dave@org_a'), 'procurement.receipt.write', 'project', pg_temp.id('prj_a'), 'Receiving on the Summer Series.');
select pg_temp.as_user('dave');
select throws_ok($$select pg_temp.receive('ev6', 'po', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_future'), 'quantity', 1,
    'asset_tags', jsonb_build_array('NWL-RNT-009'))))$$,
  '42501', 'assets.asset.write is required', 'a receiver without assets.asset.write in the org creates no unit');
select throws_ok($$select pg_temp.receive('ev6', 'po', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_deck'), 'quantity', 1,
    'venue_id', pg_temp.id('venue_a'))))$$,
  '42501', 'assets.asset.write is required', 'nor moves a lot');
select is((select r ->> 'outcome' from pg_temp.receive('ev6', 'po', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_deck'), 'quantity', 1))) r),
  'applied', 'but records a plain receipt line');
insert into world select 'rl_deck_plain', id from app.receipt_lines where goods_receipt_id = pg_temp.id('ev6');

-- The unit receipt guard ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.asset_units (asset_class_id, asset_tag, receipt_line_id) values (%L, 'NWL-DCK-001', %L)$$,
    pg_temp.id('cls_deck'), pg_temp.id('rl_radio')),
  'XR001', 'unit_receipt_element: A unit arrives on a receipt line that ordered its class''s element.', 'a unit arrives on a line that ordered its element');
select throws_ok(format($$insert into app.asset_units (asset_class_id, asset_tag, receipt_line_id) values (%L, 'NWL-RNT-010', %L)$$,
    pg_temp.id('cls_radio'), pg_temp.id('rl_radio')),
  'XR001', 'unit_receipt_exceeds: A receipt line brings in no more units than the quantity it received.', 'never more units than received');
select throws_ok(format($$update app.asset_units set receipt_line_id = %L where id = %L$$, pg_temp.id('rl_radio3'), pg_temp.id('r1')),
  'XR001', 'unit_receipt_immutable: A unit keeps the receipt line it arrived on.', 'and the link never changes');

-- Returning to the vendor ------------------------------------------------------------------------------------------------------------------
select app.transition_asset(pg_temp.id(k), 'Received', 'Available', 'Shelved.') from (values ('r1'), ('r2')) v(k);
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('cls_radio'), 'NWL-RAD-OWN') returning id) insert into world select 'own', id from x;

select throws_ok($$select app.return_goods(null, pg_temp.id('po'), 'Off Hire', '[]'::jsonb)$$,
  'XR001', 'return_event_required: Every return carries the event id it was recorded under.', 'a return needs its event id');
select throws_ok($$select pg_temp.give_back('ret1', 'po2', 'Defective', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_deck'), 'quantity', 1)))$$,
  'XR001', 'return_line_order: A return line sends back goods received on this purchase order.', 'a receipt line of another order is refused');
select throws_ok($$select pg_temp.give_back('ret1', 'po', 'Off Hire', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_deck'), 'quantity', 1,
    'venue_id', pg_temp.id('venue_a'))))$$,
  'XR001', 'return_off_hire_not_rental: Off Hire returns only goods hired on a rental line.', 'Off Hire is for rental lines');
select throws_ok($$select pg_temp.give_back('ret1', 'po', 'Off Hire', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_radio'), 'quantity', 3,
    'asset_unit_ids', jsonb_build_array(pg_temp.id('r1'), pg_temp.id('r2'), pg_temp.id('r3')))))$$,
  'XR001', 'return_exceeds_receipt: Returns never exceed what the receipt line brought in.', 'never more than the receipt line brought in');
select throws_ok($$select pg_temp.give_back('ret1', 'po', 'Off Hire', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_radio'), 'quantity', 2,
    'asset_unit_ids', jsonb_build_array(pg_temp.id('r1')))))$$,
  'XR001', 'return_units_count: Name one unit for each unit returned.', 'one unit per unit returned');
select throws_ok($$select pg_temp.give_back('ret1', 'po', 'Off Hire', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_radio'), 'quantity', 1)))$$,
  'XR001', 'return_units_count: Name one unit for each unit returned.', 'a line that brought units in returns them by unit');
select throws_ok($$select pg_temp.give_back('ret1', 'po', 'Off Hire', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_radio'), 'quantity', 1,
    'asset_unit_ids', jsonb_build_array(pg_temp.id('own')))))$$,
  'XR001', 'return_unit_not_from_receipt: A returned unit arrived on the receipt line it goes back against.', 'a unit goes back against the line it arrived on');
select throws_ok($$select pg_temp.give_back('ret1', 'po', 'Off Hire', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_radio3'), 'quantity', 1,
    'asset_unit_ids', jsonb_build_array(pg_temp.id('r3')))))$$,
  'XR001', 'return_unit_state: The unit is Received; only an Available, Damaged or In Maintenance unit goes back.', 'a unit not yet shelved does not go back');
select is((select outcome || ' ' || asset_state from app.apply_asset_scan(pg_temp.id('ev7'), pg_temp.id('org_a'), 'NWL-RNT-002', 'check-out',
    pg_temp.id('dave@org_a'))), 'applied Deployed', 'one radio goes out to a member');
select app.transition_asset(pg_temp.id('r2'), 'Deployed', 'Damaged', 'Cracked case.');
select throws_ok($$select pg_temp.give_back('ret1', 'po', 'Defective', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_radio'), 'quantity', 1,
    'asset_unit_ids', jsonb_build_array(pg_temp.id('r2')))))$$,
  'XR001', 'return_unit_in_custody: Check the unit in before it goes back to the vendor.', 'a unit still in someone''s custody does not go back');
select throws_ok($$select pg_temp.give_back('ret1', 'po', 'Defective', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_radio'), 'quantity', 1,
    'venue_id', pg_temp.id('venue_a'))))$$,
  'XR001', 'return_units_count: Name one unit for each unit returned.', 'a line that brought units in never goes back out of a lot');
select throws_ok($$select pg_temp.give_back('ret1', 'po', 'Defective', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_deck'), 'quantity', 2)))$$,
  'XR001', 'return_venue_required: This receipt line came into stock; name the venue it goes back out of.',
  'a line that came into a lot goes back out of one, so on hand never keeps what went back');
select throws_ok($$select pg_temp.give_back('ret1', 'po', 'Defective', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_deck_plain'), 'quantity', 1,
    'venue_id', pg_temp.id('venue_a'))))$$,
  'XR001', 'return_line_not_stocked: This receipt line never came into stock, so it goes back without a venue.',
  'a line that never came into stock takes nothing out of a lot');
select pg_temp.as_platform();
select is((select count(*)::int from app.goods_returns), 0, 'no refused call left a return');

select pg_temp.as_user('carol');
select throws_ok(format($$select app.transition_asset(%L, 'Available', 'Returned', 'Back to the vendor.')$$, pg_temp.id('r1')),
  'XR001', 'asset_returned_through_goods_return: A unit goes back to its vendor through a goods return on its purchase order.',
  'Returned is never reached through app.transition_asset');
select is((select r ->> 'outcome' from pg_temp.give_back('ret1', 'po', 'Off Hire', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_radio'), 'quantity', 1,
    'asset_unit_ids', jsonb_build_array(pg_temp.id('r1'))))) r),
  'applied', 'an Available radio goes back Off Hire');
select is((select asset_state::text from app.asset_units where id = pg_temp.id('r1')), 'Returned', 'and is Returned');
select is((select reason from app.asset_state_transitions where asset_unit_id = pg_temp.id('r1') and to_state = 'Returned'),
  format('Off hire on PO %s.', (select po_number from app.purchase_orders where id = pg_temp.id('po'))), 'the move names the order');
select is((select asset_unit_id from app.return_lines where goods_return_id = pg_temp.id('ret1')), pg_temp.id('r1'), 'one return line names the unit');
select is((select returned_by from app.goods_returns where id = pg_temp.id('ret1')), pg_temp.id('carol'), 'the returner is the session person');
select is((select r ->> 'outcome' from pg_temp.give_back('ret1', 'po', 'Off Hire', '[]'::jsonb) r), 'duplicate', 'a replay returns duplicate');
select is((select count(*)::int from app.return_lines), 1, 'and adds no return line');
select throws_ok($$select pg_temp.give_back('ret1', 'po2', 'Defective', '[]'::jsonb)$$,
  'XR001', 'return_event_reused: This return event already recorded a return on another purchase order.', 'a return event is never reused on another order');

select is((select r ->> 'outcome' from pg_temp.give_back('ret2', 'po', 'Defective', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_deck'), 'quantity', 2,
    'venue_id', pg_temp.id('venue_a')))) r),
  'applied', 'two deck sections go back out of the lot');
select is((select movement_kind::text || ' ' || delta from app.asset_lot_movements
    where return_line_id = (select id from app.return_lines where goods_return_id = pg_temp.id('ret2'))),
  'Vendor Return -2', 'as a Vendor Return movement on the return line');
select is((select on_hand from app.asset_lot_balances where asset_lot_id = pg_temp.id('lot')), 5::numeric, 'on hand falls by the quantity');
select throws_ok($$select pg_temp.give_back('ret3', 'po', 'Wrong Item', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_deck'), 'quantity', 3,
    'venue_id', pg_temp.id('venue_a'))))$$,
  'XR001', 'return_exceeds_receipt: Returns never exceed what the receipt line brought in.', 'the receipt line caps lot returns too');
select throws_ok($$select pg_temp.give_back('ret3', 'po', 'Wrong Item', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_deck'), 'quantity', 1,
    'venue_id', pg_temp.id('venue_b'))))$$,
  'XR001', null, 'a venue holding no lot of the class is refused');
select is((select r ->> 'outcome' from pg_temp.give_back('ret4', 'po', 'Over Delivery', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_deck_plain'), 'quantity', 1))) r),
  'applied', 'a line that never came into stock goes back as a plain line');
select is((select count(*)::int from app.asset_lot_movements m join app.return_lines r on r.id = m.return_line_id
    where r.goods_return_id = pg_temp.id('ret4')), 0, 'with no movement');
select is((select on_hand from app.asset_lot_balances where asset_lot_id = pg_temp.id('lot')), 5::numeric, 'so on hand is unchanged');
select pg_temp.as_user('gina');
select throws_ok($$select pg_temp.give_back('ret9', 'po', 'Defective', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_deck'), 'quantity', 1,
    'venue_id', pg_temp.id('venue_a'))))$$,
  '42501', 'procurement.receipt.write is required', 'a person without procurement.receipt.write returns nothing');

-- Who reads returns ------------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from app.goods_returns), 0, 'a reader without procurement.po.read reads no return');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.goods_returns), 3, 'a project member with procurement.po.read reads the returns');
select is((select count(*)::int from app.return_lines), 3, 'and their lines');
select throws_ok(format($$insert into app.goods_returns (purchase_order_id, return_reason) values (%L, 'Defective')$$, pg_temp.id('po')),
  '42501', null, 'returns are written only by app.return_goods');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'goods.returned'), 3, 'goods.returned is emitted per return');

-- The ledger and the catalog -------------------------------------------------------------------------------------------------------------------
select ok(pg_get_constraintdef((select oid from pg_constraint where conname = 'asset_lot_movements_direction')) like '%custodian_engagement_id%',
  'the direction constraint keeps R1''s engagement custodian');
select ok(exists (select 1 from pg_constraint where conname = 'asset_lot_movements_one_custodian'), 'and the one-custodian rule stays');
select throws_ok(format($$insert into app.asset_lot_movements (asset_lot_id, movement_kind, delta) values (%L, 'Receipt', 1)$$, pg_temp.id('lot')),
  '23514', null, 'a Receipt movement names its receipt line');
select throws_ok(format($$insert into app.asset_lot_movements (asset_lot_id, movement_kind, delta, receipt_line_id) values (%L, 'Count', 1, %L)$$,
    pg_temp.id('lot'), pg_temp.id('rl_deck')),
  '23514', null, 'only a Receipt movement names a receipt line');
select ok(exists (select 1 from private.sync_rpcs where rpc = 'app.receive_goods'), 'app.receive_goods is a sync RPC');
select ok(exists (select 1 from private.lifecycle_transition_rules where lifecycle = 'asset' and from_state = 'Damaged' and to_state = 'Returned'),
  'Damaged units may be Returned');
select ok(exists (select 1 from private.trash_excluded_tables where table_name = 'goods_returns'), 'goods returns decide their Trash membership');

select * from finish();
rollback;
