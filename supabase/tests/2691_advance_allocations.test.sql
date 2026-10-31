-- pgTAP: migration 2691 (R7), advance allocations and asset holds. The table's constraints (one holder, one target, a
-- bounded window, the cause and split pairs), the guard (target on the project, Catering only, whole numbers,
-- immutability, the stamped project), no direct writes for signed-in users, the parking category kind, the offering
-- class finder, and the hold guard: source of the class, rental hire period, a unit held twice, class stock, lot and
-- order-line capacity, and the class row lock that serializes holds.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

-- Offering classes ------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select offering::text || ' ' || element_id from app.asset_classes where id = pg_temp.id('cls_radio')),
  'Radios 3000.05.01-GHXST-013', 'the Radios class is bound to the canon radio');
select pg_temp.as_user('alice');
select is(app.ensure_offering_asset_class(pg_temp.id('org_a'), 'Radios'), pg_temp.id('cls_radio'), 'the class is reused');
select isnt(app.ensure_offering_asset_class(pg_temp.id('org_a'), 'Carts'), null::uuid, 'a Carts class is created');
select is((select name from app.asset_classes where org_id = pg_temp.id('org_a') and offering = 'Carts'), '4-Seat Golf Cart',
  'named from the element''s common name');
select throws_ok($$select app.ensure_offering_asset_class(pg_temp.id('org_a'), 'Travel')$$,
  'XR001', 'offering_not_asset_class: Only radios and carts are offered from an asset class.', 'travel is no asset class');
select pg_temp.as_user('gina');
select throws_ok($$select app.ensure_offering_asset_class(pg_temp.id('org_a'), 'Radios')$$, '42501', null,
  'assets.asset.write is required');
select pg_temp.as_platform();
select throws_ok(format($$insert into app.asset_classes (org_id, element_id, name, offering) values (%L, '0000.01.01-XOS-004', 'Other', 'Radios')$$,
  pg_temp.id('org_a')), '23505', null, 'one live Radios class per org');
select throws_ok(format($$update app.asset_classes set offering = 'Travel' where id = %L$$, pg_temp.id('cls_cable')),
  '23514', null, 'only Radios or Carts');

-- Constraints ------------------------------------------------------------------------------------------------------------------
select throws_ok(format($$insert into app.advance_allocations (project_id, engagement_id, roster_entry_id, service_kind, quantity,
    needed_during, needed_time_zone, origin) values (%L, %L, %L, 'Travel', 1, '[2027-06-01,2027-06-02)', 'UTC', 'Requested')$$,
  pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a'), pg_temp.id('e_kai')), '23514', null, 'one holder');
select throws_ok(format($$insert into app.advance_allocations (project_id, engagement_id, service_kind, credential_category_id, quantity,
    needed_during, needed_time_zone, origin) values (%L, %L, 'Travel', %L, 1, '[2027-06-01,2027-06-02)', 'UTC', 'Requested')$$,
  pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a'), pg_temp.id('cat_crew')), '23514', null, 'one target');
select throws_ok(format($$insert into app.advance_allocations (project_id, engagement_id, service_kind, quantity,
    needed_during, needed_time_zone, origin) values (%L, %L, 'Travel', 1, '[2027-06-01,)', 'UTC', 'Requested')$$,
  pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a')), '23514', null, 'a bounded window');
select throws_ok(format($$insert into app.advance_allocations (project_id, engagement_id, service_kind, quantity,
    needed_during, needed_time_zone, origin) values (%L, %L, 'Travel', 1, '[2027-06-01,2027-06-02)', 'UTC', 'Split')$$,
  pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a')), 'XR001', 'allocation_split_internal: A share of a pool is made by splitting the pool.',
  'a split share is made only by the split');
select throws_ok(format($$insert into app.advance_allocations (project_id, engagement_id, service_kind, quantity,
    needed_during, needed_time_zone, origin) values (%L, %L, 'Travel', 1.5, '[2027-06-01,2027-06-02)', 'UTC', 'Requested')$$,
  pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a')), 'XR001', 'allocation_quantity_whole: This item is allocated in whole numbers.',
  'trips are whole');
select throws_ok(format($$insert into app.advance_allocations (project_id, engagement_id, asset_class_id, quantity,
    needed_during, needed_time_zone, origin) values (%L, %L, %L, 1.5, '[2027-06-01,2027-06-02)', 'UTC', 'Requested')$$,
  pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a'), pg_temp.id('cls_radio')), 'XR001', 'allocation_quantity_whole: This item is allocated in whole numbers.',
  'serialized radios are whole');
select lives_ok(format($$insert into app.advance_allocations (project_id, engagement_id, asset_class_id, quantity,
    needed_during, needed_time_zone, origin) values (%L, %L, %L, 1.5, '[2027-06-01,2027-06-02)', 'UTC', 'Requested')$$,
  pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a'), pg_temp.id('cls_cable')), 'linear stock takes a fraction');
select throws_ok(format($$insert into app.advance_allocations (project_id, engagement_id, fulfillment_id, quantity,
    needed_during, needed_time_zone, origin) values (%L, %L, %L, 1, '[2027-06-01,2027-06-02)', 'UTC', 'Requested')$$,
  pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a'), pg_temp.id('ful_trv')), 'XR001',
  'allocation_target_kind: Only a catering fulfillment is allocated; travel and lodging have their own targets.', 'a fulfillment is Catering');
select throws_ok(format($$insert into app.advance_allocations (project_id, engagement_id, service_kind, quantity,
    needed_during, needed_time_zone, origin) values (%L, %L, 'Travel', 1, '[2027-06-01,2027-06-02)', 'Mars/Olympus', 'Requested')$$,
  pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a')), 'XR001', null, 'a known time zone');

insert into world select 'a_direct', id from app.advance_allocations where asset_class_id = pg_temp.id('cls_cable');
select is((select project_id from app.advance_allocations where id = pg_temp.id('a_direct')), pg_temp.id('prj_a'),
  'the project is stamped from the holder');
select is((select org_id from app.advance_allocations where id = pg_temp.id('a_direct')), pg_temp.id('org_a'), 'and the org from the project');
select throws_ok(format($$update app.advance_allocations set project_id = %L where id = %L$$, pg_temp.id('prj_a2'), pg_temp.id('a_direct')),
  'XR001', 'allocation_project_fixed: An allocation keeps the project of its holder.', 'the project never changes');
select throws_ok(format($$update app.advance_allocations set quantity = 2 where id = %L$$, pg_temp.id('a_direct')),
  'XR001', 'allocation_immutable: An allocation keeps its holder, target, window and origin; its quantity changes only by a split.',
  'the quantity changes only in a split');
select throws_ok(format($$update app.advance_allocations set needed_during = '[2027-06-02,2027-06-03)' where id = %L$$, pg_temp.id('a_direct')),
  'XR001', 'allocation_immutable: An allocation keeps its holder, target, window and origin; its quantity changes only by a split.',
  'the window never changes');
select throws_ok(format($$update app.advance_allocations set allocation_state = 'Approved' where id = %L$$, pg_temp.id('a_direct')),
  'XR001', null, 'the state moves only through its lifecycle');

select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.advance_allocations (project_id, engagement_id, service_kind, quantity,
    needed_during, needed_time_zone, origin) values (%L, %L, 'Travel', 1, '[2027-06-01,2027-06-02)', 'UTC', 'Requested')$$,
  pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a')), '42501', null, 'signed-in users write no allocation directly');
select throws_ok(format($$update app.advance_allocations set note = 'Edited.' where id = %L$$, pg_temp.id('a_direct')),
  '42501', null, 'nor change one');
select is((select count(*)::int from app.advance_allocations where id = pg_temp.id('a_direct')), 1, 'a reviewer reads them');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.advance_allocations), 0, 'a viewer without advancing.packet.read on the project reads none');

-- The category kind --------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select category_kind::text from app.credential_categories where id = pg_temp.id('cat_crew')), 'Access', 'a category is Access by default');
select lives_ok(format($$update app.credential_categories set category_kind = 'Parking' where id = %L$$, pg_temp.id('cat_crew')),
  'the kind changes while no allocation names the category');
update app.credential_categories set category_kind = 'Access' where id = pg_temp.id('cat_crew');
select pg_temp.alloc('request', 'dave', 'e_kai', 'category', 'cat_crew', 1);
select pg_temp.as_platform();
select throws_ok(format($$update app.credential_categories set category_kind = 'Parking' where id = %L$$, pg_temp.id('cat_crew')),
  'XR001', 'credential_category_kind_in_use: A category keeps its kind while open allocations name it.', 'but not under an open allocation');

-- Holds ----------------------------------------------------------------------------------------------------------------------------
insert into world select 'a_radio', pg_temp.alloc('assign', 'carol', 'eng_vendor_a', 'class', 'cls_radio', 4,
  null, jsonb_build_array(jsonb_build_object('source', 'Class Stock', 'quantity', 4)));
select pg_temp.as_platform();
select is(pg_temp.holds(pg_temp.id('a_radio')), 'stock:4', 'four radios held from class stock');
select isnt((select xmax::text from app.asset_classes where id = pg_temp.id('cls_radio')), '0',
  'the hold locked the class row, so concurrent holds of the class serialize');
select is((select project_id from app.asset_reservations where advance_allocation_id = pg_temp.id('a_radio')), pg_temp.id('prj_a'),
  'a hold takes the allocation''s project');

-- Capacity: a fifth radio from stock in an overlapping window is refused, in a separate window it fits.
insert into world select 'a_more', pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_radio', 1);
select pg_temp.as_user('carol');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved', null, '[{"source": "Class Stock", "quantity": 1}]')$$, pg_temp.id('a_more')),
  'XR001', 'reservation_over_capacity: Not enough of this class is free in that window.', 'class stock is held to the serviceable units');
select is(pg_temp.state_of(pg_temp.id('a_more')), 'Requested', 'the refused approval leaves it Requested');
insert into world select 'a_later', pg_temp.alloc('assign', 'carol', 'eng_vendor_a', 'class', 'cls_radio', 4,
  null, '[{"source": "Class Stock", "quantity": 4}]', '2027-06-10 12:00+00', '2027-06-12 12:00+00');
select is(pg_temp.holds(pg_temp.id('a_later')), 'stock:4', 'the same units are held again for a window that does not overlap');

-- The order line: two on hire for June 2027.
select lives_ok(format($$select app.decide_allocation(%L, 'Approved', null, jsonb_build_array(jsonb_build_object('source', 'Order Line', 'po_line_id', %L, 'quantity', 1)))$$,
  pg_temp.id('a_more'), pg_temp.id('l_rent')), 'a fifth radio is held on the rental line');
insert into world select 'a_more2', pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_radio', 2);
select pg_temp.as_user('carol');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved', null, jsonb_build_array(jsonb_build_object('source', 'Order Line', 'po_line_id', %L, 'quantity', 2)))$$,
  pg_temp.id('a_more2'), pg_temp.id('l_rent')),
  'XR001', 'reservation_over_capacity: Not enough of this class is free in that window.', 'an order line is held to ordered minus returned');
insert into world select 'a_july', pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_radio', 1, null, null,
  '2027-06-30 12:00+00', '2027-07-02 12:00+00');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved', null, jsonb_build_array(jsonb_build_object('source', 'Order Line', 'po_line_id', %L, 'quantity', 1)))$$,
  pg_temp.id('a_july'), pg_temp.id('l_rent')),
  'XR001', 'reservation_outside_hire_period: A hold on a rental line falls inside its hire period.', 'a rental hold falls inside the hire');

-- A pinned unit.
insert into world select 'a_pin', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1, null, null,
  '2027-06-10 12:00+00', '2027-06-12 12:00+00');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved', null, jsonb_build_array(jsonb_build_object('source', 'Unit', 'asset_unit_id', %L, 'quantity', 1)))$$,
  pg_temp.id('a_pin'), pg_temp.id('r1')),
  'XR001', 'reservation_over_capacity: Not enough of this class is free in that window.', 'a pin counts against class stock');
select pg_temp.as_platform();
select private.release_allocation_holds(pg_temp.id('a_later'), 'Released By Reviewer');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.decide_allocation(%L, 'Approved', null, jsonb_build_array(jsonb_build_object('source', 'Unit', 'asset_unit_id', %L, 'quantity', 1)))$$,
  pg_temp.id('a_pin'), pg_temp.id('r1')), 'a pin fits once the stock is free');
insert into world select 'a_pin2', pg_temp.alloc('request', 'dave', 'e_mo', 'class', 'cls_radio', 1, null, null,
  '2027-06-11 12:00+00', '2027-06-13 12:00+00');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved', null, jsonb_build_array(jsonb_build_object('source', 'Unit', 'asset_unit_id', %L, 'quantity', 1)))$$,
  pg_temp.id('a_pin2'), pg_temp.id('r1')),
  'XR001', 'reservation_unit_overlap: This unit is already held for another allocation in that window.', 'a unit is held once per window');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved', null, jsonb_build_array(jsonb_build_object('source', 'Lot', 'asset_lot_id', %L, 'quantity', 1)))$$,
  pg_temp.id('a_pin2'), pg_temp.id('lot_cable')),
  'XR001', 'reservation_source_class: A hold comes from a unit, lot or order line of the allocation''s class.', 'a source of another class');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved', null, '[{"source": "Class Stock", "quantity": 2}]')$$, pg_temp.id('a_pin2')),
  'XR001', 'allocation_sources_sum: The sources hold 2; the allocation is for 1.', 'sources sum to the quantity');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved', null, '[{"source": "Unit", "quantity": 1}]')$$, pg_temp.id('a_pin2')),
  'XR001', null, 'a unit source names its unit');

-- Lots.
insert into world select 'a_cable', pg_temp.alloc('assign', 'carol', 'eng_vendor_a', 'class', 'cls_cable', 100.25);
select pg_temp.as_platform();
select is(pg_temp.holds(pg_temp.id('a_cable')), 'lot:100.25', 'a class kept as one lot is held from it by default');
insert into world select 'a_cable2', pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_cable', 60);
select pg_temp.as_user('carol');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved', null, null)$$, pg_temp.id('a_cable2')),
  'XR001', 'reservation_over_capacity: Not enough of this class is free in that window.', 'a lot is held to its owned quantity');

-- Holds change only through their operations.
select pg_temp.as_platform();
select throws_ok(format($$update app.asset_reservations set quantity = 3 where advance_allocation_id = %L$$, pg_temp.id('a_radio')),
  'XR001', 'reservation_immutable: A hold keeps its allocation and source; its quantity and release change only by a split or a release.',
  'a hold''s quantity changes only in a split');
select throws_ok(format($$insert into app.asset_reservations (advance_allocation_id, quantity) values (%L, 1)$$, pg_temp.id('a_pin2')),
  'XR001', 'reservation_allocation_state: Stock is held for an approved allocation.', 'a Requested allocation holds nothing');
select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.asset_reservations (advance_allocation_id, quantity) values (%L, 1)$$, pg_temp.id('a_radio')),
  '42501', null, 'signed-in users write no hold directly');

select * from finish();
rollback;
