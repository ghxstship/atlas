-- pgTAP: migration 2682 (R7a), the supply bridge views. app.po_line_supply counts what each line ordered, received and
-- returned, whether the vendor acknowledged and whether a rental's off-hire is due, without prices; app.asset_unit_provenance
-- names a unit's order, vendor and price to procurement readers only, so an asset-only reader sees no row; neither view
-- is readable by the backup login.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 2681_supply_world.psql

select * from no_plan();

insert into world values
  ('ev1', '01920000-0000-7000-8682-000000000001'), ('ev2', '01920000-0000-7000-8682-000000000002'),
  ('ret1', '01920000-0000-7000-8682-000000000101');

select pg_temp.as_user('carol');
select pg_temp.receive('ev1', 'po', jsonb_build_array(
  jsonb_build_object('po_line_id', pg_temp.id('l_radio'), 'quantity', 2, 'asset_tags', jsonb_build_array('NWL-RNT-001', 'NWL-RNT-002')),
  jsonb_build_object('po_line_id', pg_temp.id('l_deck'), 'quantity', 4, 'venue_id', pg_temp.id('venue_a'))));
insert into world select 'rl_radio', id from app.receipt_lines where goods_receipt_id = pg_temp.id('ev1') and po_line_id = pg_temp.id('l_radio');
insert into world select 'r1', id from app.asset_units where asset_tag = 'NWL-RNT-001';
insert into world select 'r2', id from app.asset_units where asset_tag = 'NWL-RNT-002';
select app.transition_asset(pg_temp.id(k), 'Received', 'Available', 'Shelved.') from (values ('r1'), ('r2')) v(k);

-- Supply per line -------------------------------------------------------------------------------------------------------------------
select is((select quantity_ordered || ' ' || quantity_received || ' ' || quantity_returned || ' ' || units_received || ' ' || off_hire_due
    from app.po_line_supply where po_line_id = pg_temp.id('l_radio')),
  '3 2 0 2 true', 'the rental line ordered 3, received 2 by unit, and its ended hire is due back');
select is((select quantity_received || ' ' || units_received || ' ' || off_hire_due from app.po_line_supply where po_line_id = pg_temp.id('l_deck')),
  '4 0 false', 'the deck line received 4 into stock and owes no off-hire');
select is((select off_hire_due from app.po_line_supply where po_line_id = pg_temp.id('l_future')), false, 'a hire that has not ended is not due');
select is((select acknowledged from app.po_line_supply where po_line_id = pg_temp.id('l_radio')), false, 'the vendor has not acknowledged yet');
select pg_temp.as_platform();
insert into app.po_acknowledgments (purchase_order_id) values (pg_temp.id('po'));
select pg_temp.as_user('carol');
select is((select acknowledged from app.po_line_supply where po_line_id = pg_temp.id('l_radio')), true, 'and then has');
select pg_temp.give_back('ret1', 'po', 'Off Hire', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_radio'), 'quantity', 2,
  'asset_unit_ids', jsonb_build_array(pg_temp.id('r1'), pg_temp.id('r2')))));
select is((select quantity_returned || ' ' || off_hire_due from app.po_line_supply where po_line_id = pg_temp.id('l_radio')),
  '2 false', 'once everything received went back, no off-hire is due');
select hasnt_column('app', 'po_line_supply', 'unit_price_minor', 'the supply view carries no price');

-- Provenance per unit ---------------------------------------------------------------------------------------------------------------
select is((select po_number || ' ' || (vendor_id = pg_temp.id('ven'))::text || ' ' || acquisition_kind || ' ' || unit_price_minor || ' ' || currency_code
    from app.asset_unit_provenance where asset_unit_id = pg_temp.id('r1')),
  (select po_number from app.purchase_orders where id = pg_temp.id('po')) || ' true Rental 5000 USD', 'a procurement reader sees the order, vendor, kind and price');
select is((select upper(hire_period) from app.asset_unit_provenance where asset_unit_id = pg_temp.id('r1')), '2026-01-10 12:00+00'::timestamptz,
  'and the hire end');
select pg_temp.as_user('gina');
select ok((select count(*) from app.asset_units where id = pg_temp.id('r1')) = 1, 'an asset-only reader reads the unit');
select is((select count(*)::int from app.asset_unit_provenance), 0, 'but no provenance row, so never its cost');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.po_line_supply), 0, 'another org reads no supply rows');
select pg_temp.as_anon();
select throws_ok('select 1 from app.po_line_supply', '42501', null, 'anon cannot read supply');
select throws_ok('select 1 from app.asset_unit_provenance', '42501', null, 'nor provenance');
select pg_temp.as_platform();

select is(has_table_privilege('xos_backup', 'app.po_line_supply', 'select'), false, 'the backup login cannot read supply');
select is(has_table_privilege('xos_backup', 'app.asset_unit_provenance', 'select'), false, 'nor provenance');

select * from finish();
rollback;
