-- pgTAP: migration 2692 (R7), possession links. Custody holder rules (a unit held for someone else, the wrong person, a
-- hold used up, a window that ended, too few left for holds that hold now), no direct custody insert for signed-in
-- users while app.record_asset_custody works through the scan and sets Deployed, app.apply_asset_scan keeps one
-- signature and stays a sync RPC and moves a lot quantity out and back for an engagement with the entry and the hold,
-- a roster per diem once a day, and a mismatched allocation refused on credentials, fulfillment lines, rooms, travel
-- and per diems, and re-installed tenant guards that keep the references the tables already had.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

insert into world values
  ('ev1', '01920000-0000-7000-8692-000000000001'), ('ev2', '01920000-0000-7000-8692-000000000002'),
  ('ev3', '01920000-0000-7000-8692-000000000003'), ('ev4', '01920000-0000-7000-8692-000000000004'),
  ('ev5', '01920000-0000-7000-8692-000000000005'), ('ev6', '01920000-0000-7000-8692-000000000006');

create function pg_temp.scan(p_event text, p_code text, p_action app.asset_scan_action, p_engagement text, p_entry text,
  p_hold uuid, p_quantity numeric default null) returns text
language sql as $$
  select s.outcome from app.apply_asset_scan(pg_temp.id(p_event), pg_temp.id('org_a'), p_code, p_action, null,
    pg_temp.id(p_engagement), null, null, null, p_quantity, pg_temp.id(p_entry), p_hold) s
$$;

-- One signature, still synced ------------------------------------------------------------------------------------------------
select is((select count(*)::int from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app' and p.proname = 'apply_asset_scan'), 1, 'apply_asset_scan keeps one signature');
select ok(exists (select 1 from private.sync_rpcs where rpc = 'app.apply_asset_scan'), 'and stays a sync RPC');

-- Direct custody is gone; the RPC keeps its rule ----------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.asset_custody (asset_unit_id, custodian_membership_id) values (%L, %L)$$,
  pg_temp.id('r4'), pg_temp.id('frank@org_a')), '42501', null, 'signed-in users insert no custody row');
select isnt(app.record_asset_custody(pg_temp.id('r4'), pg_temp.id('frank@org_a')), null::uuid, 'app.record_asset_custody hands the radio to Frank');
select pg_temp.as_platform();
select is((select asset_state::text from app.asset_units where id = pg_temp.id('r4')), 'Deployed', 'through the scan, so the radio is Deployed');
select pg_temp.as_user('carol');
select isnt(app.record_asset_custody(pg_temp.id('r4'), null, null, pg_temp.id('venue_a')), null::uuid, 'with no custodian it checks in');
select pg_temp.as_platform();
select is((select asset_state::text from app.asset_units where id = pg_temp.id('r4')), 'Available', 'and the radio is Available');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.record_asset_custody(%L, %L)$$, pg_temp.id('r4'), pg_temp.id('frank@org_a')), '42501',
  'assets.custody.write is required', 'it needs assets.custody.write');

-- Holder rules ------------------------------------------------------------------------------------------------------------------
-- Kai holds radio r1 now; Mo holds two from class stock now.
insert into world select 'kai_now', pg_temp.alloc('assign', 'carol', 'e_kai', 'class', 'cls_radio', 1, null,
  jsonb_build_array(jsonb_build_object('source', 'Unit', 'asset_unit_id', pg_temp.id('r1'), 'quantity', 1)),
  now() - interval '1 hour', now() + interval '2 days');
insert into world select 'mo_now', pg_temp.alloc('assign', 'carol', 'e_mo', 'class', 'cls_radio', 2, null, null,
  now() - interval '1 hour', now() + interval '2 days');
select pg_temp.as_platform();
insert into world select 'h_kai', id from app.asset_reservations where advance_allocation_id = pg_temp.id('kai_now');
insert into world select 'h_mo', id from app.asset_reservations where advance_allocation_id = pg_temp.id('mo_now');

select pg_temp.as_user('carol');
select throws_ok($$select pg_temp.scan('ev1', 'NWL-RAD-001', 'check-out', 'eng_vendor_a', 'e_mo', null)$$, 'XR001',
  'asset_reserved_for_other: This asset is held for someone else now.', 'a unit held for Kai never goes to Mo unreserved');
select throws_ok($$select pg_temp.scan('ev1', 'NWL-RAD-001', 'check-out', 'eng_vendor_a', 'e_mo', pg_temp.id('h_kai'))$$, 'XR001',
  'custody_not_reserved_holder: A held asset goes only to the holder of its hold.', 'nor against Kai''s hold');
select throws_ok($$select pg_temp.scan('ev1', 'NWL-RAD-002', 'check-out', 'eng_vendor_a', 'e_kai', pg_temp.id('h_kai'))$$, 'XR001',
  'custody_not_reserved_holder: A held asset goes only to the holder of its hold.', 'a pin covers only its unit');
select throws_ok($$select pg_temp.scan('ev1', 'NWL-RAD-002', 'check-out', 'eng_vendor_a', 'e_una', null)$$, 'XR001',
  'custody_roster_entry_not_live: Gear goes to a roster entry accepted by the reviewer and by the person.', 'a Draft entry takes no gear');
select throws_ok($$select pg_temp.scan('ev1', 'NWL-RAD-002', 'check-out', 'eng_ivy_a', 'e_kai', null)$$, 'XR001',
  'custody_roster_engagement: The person holding the asset is on the custodian engagement''s roster.', 'the entry is on the custodian engagement');
-- Three radios are free (r2 to r4) and Mo's hold still owes two, so one may go out unreserved, not two.
select is(pg_temp.scan('ev1', 'NWL-RAD-004', 'check-out', 'eng_ivy_a', null, null), 'applied', 'one unreserved radio goes to Ivy');
select throws_ok($$select pg_temp.scan('ev2', 'NWL-RAD-003', 'check-out', 'eng_ivy_a', null, null)$$, 'XR001',
  'asset_class_held_for_reservations: The units left of this class are held for others now; issue it against a hold.',
  'the last two are held for Mo''s hold');
select is(pg_temp.scan('ev2', 'NWL-RAD-001', 'check-out', 'eng_vendor_a', 'e_kai', pg_temp.id('h_kai')), 'applied', 'Kai''s radio goes to Kai');
select is(pg_temp.scan('ev3', 'NWL-RAD-002', 'check-out', 'eng_vendor_a', 'e_mo', pg_temp.id('h_mo')), 'applied', 'one of Mo''s two');
select is(pg_temp.scan('ev4', 'NWL-RAD-003', 'check-out', 'eng_vendor_a', 'e_mo', pg_temp.id('h_mo')), 'applied', 'and the other');
select pg_temp.as_platform();
select is((select reservation_id from app.asset_custody where id = pg_temp.id('ev3')), pg_temp.id('h_mo'), 'custody names the hold');
-- Hold used up and window ended.
select pg_temp.as_user('carol');
select pg_temp.scan('ev5', 'NWL-RAD-004', 'check-in', null, null, null);
select pg_temp.as_user('carol');
select throws_ok($$select pg_temp.scan('ev6', 'NWL-RAD-004', 'check-out', 'eng_vendor_a', 'e_mo', pg_temp.id('h_mo'))$$, 'XR001',
  'custody_reservation_exhausted: Everything this hold covers is already issued.', 'a hold issues no more than it holds');
insert into world select 'past', pg_temp.alloc('assign', 'carol', 'e_mo', 'class', 'cls_cable', 5, null, null,
  now() - interval '3 days', now() + interval '1 hour');
select pg_temp.as_platform();
insert into world select 'h_past', id from app.asset_reservations where advance_allocation_id = pg_temp.id('past');
alter table app.advance_allocations disable trigger t40_guard_advance_allocation;
update app.advance_allocations set needed_during = tstzrange(now() - interval '3 days', now() - interval '1 hour') where id = pg_temp.id('past');
alter table app.advance_allocations enable trigger t40_guard_advance_allocation;
select pg_temp.as_user('carol');
select throws_ok(format($$select pg_temp.scan('ev6', 'LOT:%s', 'check-out', 'eng_vendor_a', 'e_mo', pg_temp.id('h_past'), 1)$$, pg_temp.id('lot_cable')),
  'XR001', 'custody_reservation_window: The hold''s window has ended.', 'a hold whose window ended issues nothing');

-- Lots out and back ------------------------------------------------------------------------------------------------------------
insert into world select 'cable', pg_temp.alloc('assign', 'carol', 'e_kai', 'class', 'cls_cable', 40, null, null,
  now() - interval '1 hour', now() + interval '2 days');
select pg_temp.as_platform();
insert into world select 'h_cable', id from app.asset_reservations where advance_allocation_id = pg_temp.id('cable');
select pg_temp.as_user('carol');
select is(pg_temp.scan('ev6', 'LOT:' || pg_temp.id('lot_cable'), 'check-out', 'eng_vendor_a', 'e_kai', pg_temp.id('h_cable'), 25.5), 'applied',
  'a lot quantity goes out to the engagement for Kai against the hold');
select pg_temp.as_platform();
select is((select movement_kind::text || ' ' || delta || ' ' || (roster_entry_id = pg_temp.id('e_kai'))::text || ' ' || (reservation_id = pg_temp.id('h_cable'))::text
           from app.asset_lot_movements where id = pg_temp.id('ev6')), 'Check Out -25.5 true true', 'a Check Out naming the entry and the hold');
select pg_temp.as_user('carol');
select is((select s.outcome from app.apply_asset_scan('01920000-0000-7000-8692-000000000099', pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot_cable'),
    'check-in', null, pg_temp.id('eng_vendor_a'), null, null, null, 10, pg_temp.id('e_kai'), pg_temp.id('h_cable')) s), 'applied',
  'and part comes back by a Check In naming them');
select pg_temp.as_platform();
select is((select movement_kind::text from app.asset_lot_movements where id = '01920000-0000-7000-8692-000000000099'), 'Check In', 'a Check In');
select throws_ok(format($$insert into app.asset_lot_movements (asset_lot_id, movement_kind, delta, reservation_id) values (%L, 'Count', 1, %L)$$,
  pg_temp.id('lot_cable'), pg_temp.id('h_cable')), '23514', null, 'a recount names no hold');
select throws_ok(format($$insert into app.asset_lot_movements (asset_lot_id, movement_kind, delta, custodian_engagement_id, roster_entry_id) values (%L, 'Check Out', -125, %L, %L)$$,
  pg_temp.id('lot_cable'), pg_temp.id('eng_vendor_a'), pg_temp.id('e_kai')), 'XR001',
  'lot_held_for_reservations: What is left of this lot is held for others now; issue it against a hold.', 'an unreserved check-out leaves what holds owe');

-- Possession links agree with the allocation ----------------------------------------------------------------------------------
insert into world select 'badge', pg_temp.alloc('assign', 'carol', 'e_kai', 'category', 'cat_crew', 1);
insert into world select 'room', pg_temp.alloc('assign', 'carol', 'e_kai', 'block', 'blk', 1);
insert into world select 'meals', pg_temp.alloc('assign', 'carol', 'e_kai', 'fulfillment', 'ful_cat', 1);
insert into world select 'trip', pg_temp.alloc('assign', 'carol', 'e_kai', 'travel', null, 1);
insert into world select 'pd', pg_temp.alloc('assign', 'carol', 'e_kai', 'per_diem', null, 3);
select pg_temp.as_platform();
select throws_ok(format($$insert into app.credentials (credential_category_id, holder_person_id, allocation_id) values (%L, %L, %L)$$,
  pg_temp.id('cat_crew'), pg_temp.id('kai'), pg_temp.id('badge')), 'XR001',
  'allocation_issue_only: Items of an allocation are handed over by issuing the allocation.', 'only issuing writes a linked row');
select private.begin_trusted_operation('allocation_issue');
select throws_ok(format($$insert into app.credentials (credential_category_id, holder_person_id, allocation_id, engagement_id) values (%L, %L, %L, %L)$$,
  pg_temp.id('cat_crew'), pg_temp.id('mo'), pg_temp.id('badge'), pg_temp.id('eng_vendor_a')), 'XR001', null,
  'a badge for another person is refused (credentials_allocation_mismatch)');
select throws_ok(format($$insert into app.fulfillment_lines (fulfillment_id, description, person_id, allocation_id) values (%L, 'Lunch', %L, %L)$$,
  pg_temp.id('ful_trv'), pg_temp.id('kai'), pg_temp.id('meals')), 'XR001', null, 'a line of another fulfillment (fulfillment_lines_allocation_mismatch)');
select throws_ok(format($$insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on, allocation_id) values (%L, %L, '2027-06-01', '2027-06-02', %L)$$,
  pg_temp.id('blk'), pg_temp.id('mo'), pg_temp.id('room')), 'XR001', null, 'a room for another guest (accommodation_assignments_allocation_mismatch)');
select throws_ok(format($$insert into app.travel_segments (project_id, person_id, engagement_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_time_zone, allocation_id)
    values (%L, %L, %L, 'Flight', 'BOS', '2027-06-01 08:00+00', 'America/New_York', 'MIA', 'America/New_York', %L)$$,
  pg_temp.id('prj_a'), pg_temp.id('kai'), pg_temp.id('eng_vendor_a'), pg_temp.id('badge')), 'XR001', null,
  'a trip under a badge allocation (travel_segments_allocation_mismatch)');
select throws_ok(format($$insert into app.per_diems (project_id, roster_entry_id, day, amount_minor, currency_code, allocation_id) values (%L, %L, '2027-06-01', 100, 'USD', %L)$$,
  pg_temp.id('prj_a'), pg_temp.id('e_mo'), pg_temp.id('pd')), 'XR001', null, 'a per diem for another entry (per_diems_allocation_mismatch)');
select lives_ok(format($$insert into app.per_diems (project_id, roster_entry_id, day, amount_minor, currency_code, allocation_id) values (%L, %L, '2027-06-01', 100, 'USD', %L)$$,
  pg_temp.id('prj_a'), pg_temp.id('e_kai'), pg_temp.id('pd')), 'a per diem for Kai''s entry');
select throws_ok(format($$insert into app.per_diems (project_id, roster_entry_id, day, amount_minor, currency_code, allocation_id) values (%L, %L, '2027-06-01', 100, 'USD', %L)$$,
  pg_temp.id('prj_a'), pg_temp.id('e_kai'), pg_temp.id('pd')), '23505', null, 'one per diem per roster entry and day');
select private.end_trusted_operation('allocation_issue');
select throws_ok(format($$update app.per_diems set allocation_id = null where allocation_id = %L$$, pg_temp.id('pd')), 'XR001', null,
  'an issued row keeps its allocation');
select throws_ok(format($$insert into app.per_diems (project_id, roster_entry_id, engagement_id, day, amount_minor, currency_code) values (%L, %L, %L, '2027-06-02', 100, 'USD')$$,
  pg_temp.id('prj_a'), pg_temp.id('e_kai'), pg_temp.id('eng_vendor_a')), '23514', null, 'a per diem names one worker');
select throws_ok(format($$insert into app.per_diems (project_id, roster_entry_id, day, amount_minor, currency_code) values (%L, %L, '2027-06-02', 100, 'USD')$$,
  pg_temp.id('prj_a'), pg_temp.id('e_una')), 'XR001',
  'roster_worker_not_working: A roster per diem goes to an entry accepted by both sides while its engagement is Active or Closing.',
  'a roster per diem goes to a working entry');
select is((select count(*)::int from pg_catalog.pg_trigger t where t.tgrelid = 'app.per_diems'::regclass and t.tgname = 't38_guard_engaged_worker'), 1,
  'guard_engaged_worker is left to A130');

-- A badge under a company engagement for a person on its roster.
select lives_ok(format($$insert into app.credentials (credential_category_id, holder_person_id, engagement_id) values (%L, %L, %L)$$,
  pg_temp.id('cat_crew'), pg_temp.id('kai'), pg_temp.id('eng_vendor_a')), 'a rostered person passes credential_engagement_holder');
select throws_ok(format($$insert into app.credentials (credential_category_id, holder_person_id, engagement_id) values (%L, %L, %L)$$,
  pg_temp.id('cat_crew'), pg_temp.id('una'), pg_temp.id('eng_vendor_a')), 'XR001', null, 'a Draft entry''s person does not');

-- Re-installing the tenant guards keeps the references the tables already had.
select ok((select encode(t.tgargs, 'escape') like '%app.fulfillments%app.engagements%engagement_id%app.advance_allocations%'
           from pg_catalog.pg_trigger t
           where t.tgrelid = 'app.travel_segments'::regclass and t.tgname = 't30_refuse_cross_org_reference'),
  'travel_segments keeps the engagement reference from 0971 in its cross-org guard');
select ok((select encode(t.tgargs, 'escape') like '%app.memberships%app.engagements%engagement_roster_entries%advance_allocations%'
           from pg_catalog.pg_trigger t
           where t.tgrelid = 'app.per_diems'::regclass and t.tgname = 't30_refuse_cross_org_reference'),
  'per_diems keeps the membership and engagement references from 0981');

select * from finish();
rollback;
