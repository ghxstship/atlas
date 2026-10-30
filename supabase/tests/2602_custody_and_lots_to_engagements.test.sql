-- pgTAP: migration 2602 (R1), lot quantities and units to an engagement. A lot check-out to an Active engagement
-- applies and replays as duplicate; both custodians or none are refused; another project and a Canceled engagement
-- are refused; the engaged person reads the movement and an unrelated person does not; unit custody to an engagement
-- works as before; a Check Out row without a custodian violates the constraint; the event names the engagement.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');

select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('quinn'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01')
  returning id) insert into world select 'eng_quinn_a', id from x;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_quinn_a', 'Onboarding', 'Canceled');

select pg_temp.as_user('carol');
with x as (insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_a'), '9000.03.01-XPMS-003', 'Digital Two-Way Radio') returning id) insert into world select 'cls', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag, home_venue_id) values (pg_temp.id('cls'), 'NWL-RAD-201', pg_temp.id('venue_a')) returning id) insert into world select 'r1', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag, home_venue_id) values (pg_temp.id('cls'), 'NWL-RAD-202', pg_temp.id('venue_a')) returning id) insert into world select 'r2', id from x;
with x as (insert into app.asset_lots (asset_class_id, venue_id, quantity) values (pg_temp.id('cls'), pg_temp.id('venue_a'), 20) returning id) insert into world select 'lot', id from x;
select app.transition_asset(pg_temp.id(k), 'Proposed', 'Received', 'Delivered.') from (values ('r1'), ('r2')) v(k);
select app.transition_asset(pg_temp.id(k), 'Received', 'Available', 'Shelved.') from (values ('r1'), ('r2')) v(k);
insert into world values
  ('ev1', '01920000-0000-7000-8460-000000000001'), ('ev2', '01920000-0000-7000-8460-000000000002'),
  ('ev3', '01920000-0000-7000-8460-000000000003'), ('ev4', '01920000-0000-7000-8460-000000000004'),
  ('ev5', '01920000-0000-7000-8460-000000000005'), ('ev6', '01920000-0000-7000-8460-000000000006');

-- Lots to an engagement ------------------------------------------------------------------------------------------------------
select is((select outcome || ' ' || on_hand from app.apply_asset_scan(pg_temp.id('ev1'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), 'check-out',
    null, pg_temp.id('eng_ivy_a'), null, null, null, 4)),
  'applied 16', 'a lot check-out to an Active engagement applies');
select is((select custodian_engagement_id from app.asset_lot_movements where id = pg_temp.id('ev1')), pg_temp.id('eng_ivy_a'), 'the movement names the engagement');
select is((select project_id from app.asset_lot_movements where id = pg_temp.id('ev1')), pg_temp.id('prj_a'), 'and is out for the engagement''s project');
select is((select outcome || ' ' || on_hand from app.apply_asset_scan(pg_temp.id('ev1'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), 'check-out',
    null, pg_temp.id('eng_ivy_a'), null, null, null, 4)),
  'duplicate 16', 'a replay returns duplicate');
select throws_ok(format($$select * from app.apply_asset_scan(%L, %L, %L, 'check-out', %L, %L, null, null, null, 2)$$,
    pg_temp.id('ev2'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), pg_temp.id('dave@org_a'), pg_temp.id('eng_ivy_a')),
  'XR001', 'asset_scan_custodian_required: Name the one member or engagement that takes the quantity.', 'both custodians are refused');
select throws_ok(format($$select * from app.apply_asset_scan(%L, %L, %L, 'check-out', null, null, null, null, null, 2)$$,
    pg_temp.id('ev2'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot')),
  'XR001', 'asset_scan_custodian_required: Name the one member or engagement that takes the quantity.', 'no custodian is refused');
select throws_ok(format($$select * from app.apply_asset_scan(%L, %L, %L, 'check-out', null, %L, null, %L, null, 2)$$,
    pg_temp.id('ev2'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), pg_temp.id('eng_ivy_a'), pg_temp.id('prj_a2')),
  'XR001', 'asset_scan_engagement_project: Gear handed to an engagement is out for the engagement''s own project.', 'another project is refused');
select throws_ok(format($$select * from app.apply_asset_scan(%L, %L, %L, 'check-out', null, %L, null, null, null, 2)$$,
    pg_temp.id('ev2'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), pg_temp.id('eng_quinn_a')),
  'XR001', 'asset_scan_engagement_closed: Gear goes to an engagement that is still open.', 'a Canceled engagement is refused');
select is((select outcome from app.apply_asset_scan(pg_temp.id('ev2'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), 'check-out',
    pg_temp.id('dave@org_a'), null, null, pg_temp.id('prj_a'), null, 2)),
  'applied', 'a lot check-out to a member is unchanged');
select is((select outcome || ' ' || on_hand from app.apply_asset_scan(pg_temp.id('ev3'), pg_temp.id('org_a'), 'LOT:' || pg_temp.id('lot'), 'check-in',
    null, pg_temp.id('eng_ivy_a'), null, null, null, 4)),
  'applied 18', 'the engagement checks the quantity back in');

-- Who reads the movements ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.asset_lot_movements), 2, 'the engaged person reads the movements made to their engagement');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.asset_lot_movements), 0, 'an unrelated person reads none');
select pg_temp.as_user('dave');
select ok((select count(*)::int from app.asset_lot_movements) >= 1, 'the member custodian still reads their own movement');
select pg_temp.as_user('carol');

-- Units to an engagement -------------------------------------------------------------------------------------------------------
select is((select outcome || ' ' || asset_state from app.apply_asset_scan(pg_temp.id('ev4'), pg_temp.id('org_a'), 'NWL-RAD-201', 'check-out',
    null, pg_temp.id('eng_ivy_a'))),
  'applied Deployed', 'unit custody to an engagement is unchanged');
select is((select project_id from app.asset_custody where id = pg_temp.id('ev4')), pg_temp.id('prj_a'), 'out for the engagement''s project');
select throws_ok(format($$select * from app.apply_asset_scan(%L, %L, 'NWL-RAD-202', 'check-out', null, %L)$$,
    pg_temp.id('ev5'), pg_temp.id('org_a'), pg_temp.id('eng_quinn_a')),
  'XR001', 'asset_scan_engagement_closed: Gear goes to an engagement that is still open.', 'a unit never goes to a Canceled engagement');
select throws_ok(format($$select * from app.apply_asset_scan(%L, %L, 'NWL-RAD-202', 'check-out', null, %L, null, %L)$$,
    pg_temp.id('ev5'), pg_temp.id('org_a'), pg_temp.id('eng_ivy_a'), pg_temp.id('prj_a2')),
  'XR001', 'asset_scan_engagement_project: Gear handed to an engagement is out for the engagement''s own project.', 'nor out for another project');

-- The ledger's own rules -------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select throws_ok(format($$insert into app.asset_lot_movements (asset_lot_id, movement_kind, delta) values (%L, 'Check Out', -1)$$, pg_temp.id('lot')),
  '23514', null, 'a Check Out without a custodian violates the constraint');
select throws_ok(format($$insert into app.asset_lot_movements (asset_lot_id, movement_kind, delta, custodian_membership_id, custodian_engagement_id) values (%L, 'Check Out', -1, %L, %L)$$,
    pg_temp.id('lot'), pg_temp.id('dave@org_a'), pg_temp.id('eng_ivy_a')),
  '23514', null, 'and so does one with two custodians');
select throws_ok(format($$insert into app.asset_lot_movements (asset_lot_id, movement_kind, delta, custodian_engagement_id) values (%L, 'Check Out', -1, %L)$$,
    pg_temp.id('lot'), pg_temp.id('eng_ivy_b')),
  'XR001', null, 'a lot never goes to another org''s engagement');
select ok((select data ? 'custodian_engagement_id' from app.domain_events where event_type = 'asset.lot_moved' and subject_id = pg_temp.id('lot') limit 1),
  'lot events name the engagement');

select * from finish();
rollback;
