-- pgTAP: A11 logistics and hospitality (migration 0440). Display numbers from the project sequence,
-- dock check-in stamping and authority, the fulfillment lifecycle (every allowed and refused move),
-- closed fulfillment lines, accommodation blocks and assignments (room count, window, duplicates),
-- RLS for the new tables (same tenant, cross tenant, anon, role bands) and the domain events.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(51);

-- Fixtures: a dock at venue_a and a person to lodge --------------------------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DOCK-A', 'Dock A') returning id) insert into world select 'dock', id from x;

-- Display numbers ------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.shipments (project_id, direction) values (pg_temp.id('prj_a'), 'Inbound') returning id) insert into world select 'shp', id from x;
with x as (insert into app.fulfillments (project_id, fulfillment_kind, title) values (pg_temp.id('prj_a'), 'Catering', 'Crew Catering') returning id) insert into world select 'ful', id from x;
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_a'), 'Task', 'Hang the banners', 'Y', 'Declared') returning id) insert into world select 'task', id from x;
select is((select shipment_number from app.shipments where id = pg_temp.id('shp')), 1::bigint, 'the first shipment takes number 1 of the project sequence');
select is((select fulfillment_number from app.fulfillments where id = pg_temp.id('ful')), 2::bigint, 'a fulfillment takes the next number of the same sequence');
select is((select record_number from app.records where id = pg_temp.id('task')), 3::bigint, 'records share the sequence, so a key names one thing');
select is((select app.shipment_display_key(s) from app.shipments s where s.id = pg_temp.id('shp')), 'NWL-1', 'the shipment display key is {project_key}-{number}');
select is((select app.fulfillment_display_key(f) from app.fulfillments f where f.id = pg_temp.id('ful')), 'NWL-2', 'and so is the fulfillment display key');
select throws_ok($$update app.shipments set shipment_number = 99 where id = (select id from world where key = 'shp')$$,
  'XR001', 'display_number_immutable: A row keeps its display key.', 'a display number never changes');
select throws_ok($$update app.fulfillments set project_id = (select id from world where key = 'prj_a2') where id = (select id from world where key = 'ful')$$,
  'XR001', null, 'a fulfillment stays in its project');
with x as (insert into app.shipments (project_id, direction, shipment_number) values (pg_temp.id('prj_a'), 'Outbound', 500) returning id) insert into world select 'shp2', id from x;
select is((select shipment_number from app.shipments where id = pg_temp.id('shp2')), 4::bigint, 'a caller cannot choose the number');

-- Dock check-in --------------------------------------------------------------------------------------------
with x as (insert into app.dock_slots (project_id, zone_id, shipment_id, starts_at, ends_at)
  values (pg_temp.id('prj_a'), pg_temp.id('dock'), pg_temp.id('shp'), '2027-06-01 06:00+00', '2027-06-01 08:00+00') returning id) insert into world select 'slot', id from x;
select pg_temp.as_user('gina');
select is((select count(*)::int from app.dock_slots), 0, 'a Viewer outside the project reads no dock slots');
update app.dock_slots set checked_in_at = now() where id = pg_temp.id('slot');
select pg_temp.as_platform();
select is((select checked_in_at from app.dock_slots where id = pg_temp.id('slot')), null, 'or checks one in');
select pg_temp.as_user('frank');
update app.dock_slots set checked_in_at = '2000-01-01' where id = pg_temp.id('slot');
select is((select checked_in_by from app.dock_slots where id = pg_temp.id('slot')), pg_temp.id('frank'), 'a Field project member checks a shipment in and is stamped');
select ok((select checked_in_at > '2020-01-01' from app.dock_slots where id = pg_temp.id('slot')), 'with the database time, not the caller''s');
select pg_temp.as_user('dave');
update app.dock_slots set checked_in_at = null, checked_in_by = pg_temp.id('dave') where id = pg_temp.id('slot');
select is((select checked_in_by from app.dock_slots where id = pg_temp.id('slot')), pg_temp.id('frank'), 'the check-in stamp is kept once set');
select throws_ok($$update app.dock_slots set starts_at = '2027-06-01 05:00+00' where id = (select id from world where key = 'slot')$$,
  'XR001', 'dock_slot_checked_in: A checked-in dock slot keeps its dock, window and shipment.', 'a checked-in slot keeps its window');
with x as (insert into app.dock_slots (project_id, zone_id, starts_at, ends_at, deleted_at)
  values (pg_temp.id('prj_a'), pg_temp.id('dock'), '2027-06-02 06:00+00', '2027-06-02 08:00+00', now()) returning id) insert into world select 'slot_gone', id from x;
select throws_ok($$update app.dock_slots set checked_in_at = now() where id = (select id from world where key = 'slot_gone')$$,
  'XR001', 'dock_slot_canceled: A canceled dock slot cannot be checked in.', 'a canceled slot cannot be checked in');

-- Fulfillment lifecycle ------------------------------------------------------------------------------------
select is((select fulfillment_state::text from app.fulfillments where id = pg_temp.id('ful')), 'Proposed', 'a fulfillment starts Proposed');
select is((select count(*)::int from app.fulfillment_state_transitions where fulfillment_id = pg_temp.id('ful') and from_state is null), 1, 'with its creation entry in the ledger');
select throws_ok($$insert into app.fulfillments (project_id, fulfillment_kind, title, fulfillment_state) values ((select id from world where key = 'prj_a'), 'Travel', 'Flights', 'Active')$$,
  'XR001', null, 'a new fulfillment cannot start Active');
select throws_ok($$update app.fulfillments set fulfillment_state = 'Active' where id = (select id from world where key = 'ful')$$,
  'XR001', null, 'the state changes only through its RPC');
select throws_ok($$select app.transition_fulfillment((select id from world where key = 'ful'), 'Proposed', 'Active', ' ')$$,
  'XR001', 'transition_reason_required: Every state change carries a reason.', 'every move carries a reason');
select throws_ok($$select app.transition_fulfillment((select id from world where key = 'ful'), 'Proposed', 'Complete', 'Delivered.')$$, 'XR001', 'fulfillment_transition_not_allowed: A fulfillment cannot move from Proposed to Complete.', 'Proposed cannot jump to Complete');
select throws_ok($$select app.transition_fulfillment((select id from world where key = 'ful'), 'Active', 'Complete', 'Delivered.')$$,
  'XR001', null, 'compare-and-set refuses a stale expected state');
select lives_ok($$select app.transition_fulfillment((select id from world where key = 'ful'), 'Proposed', 'Active', 'Caterer confirmed.')$$, 'Proposed to Active');
select lives_ok($$select app.transition_fulfillment((select id from world where key = 'ful'), 'Active', 'Blocked', 'Waiting on dietary counts.')$$, 'Active to Blocked');
select lives_ok($$select app.transition_fulfillment((select id from world where key = 'ful'), 'Blocked', 'Active', 'Counts received.')$$, 'Blocked to Active');
select lives_ok($$select app.transition_fulfillment((select id from world where key = 'ful'), 'Active', 'Complete', 'Served.')$$, 'Active to Complete');
select throws_ok($$insert into app.fulfillment_lines (fulfillment_id, description) values ((select id from world where key = 'ful'), 'Late snack')$$,
  'XR001', null, 'a Complete fulfillment takes no new lines');
select lives_ok($$select app.transition_fulfillment((select id from world where key = 'ful'), 'Complete', 'Active', 'Second service added.')$$, 'Complete reopens to Active');
select lives_ok($$select app.transition_fulfillment((select id from world where key = 'ful'), 'Active', 'Canceled', 'Show canceled.')$$, 'Active to Canceled');
select throws_ok($$select app.transition_fulfillment((select id from world where key = 'ful'), 'Canceled', 'Active', 'Back on.')$$, 'XR001', 'fulfillment_transition_not_allowed: A fulfillment cannot move from Canceled to Active.', 'Canceled is final');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where subject_id = pg_temp.id('ful') and event_type = 'fulfillment.state_changed'), 6, 'each move emits fulfillment.state_changed');
select pg_temp.as_user('frank');
with x as (insert into app.fulfillments (project_id, fulfillment_kind, title) values (pg_temp.id('prj_a'), 'Amenity', 'Green Room Supplies') returning id) insert into world select 'ful2', id from x;
select pg_temp.as_user('gina');
select throws_ok($$select app.transition_fulfillment((select id from world where key = 'ful2'), 'Proposed', 'Active', 'Confirmed.')$$, '42501', null, 'a Viewer cannot move a fulfillment');
select pg_temp.as_user('xavier');
select throws_ok($$select app.transition_fulfillment((select id from world where key = 'ful2'), 'Proposed', 'Active', 'Confirmed.')$$, '42501', null, 'another org cannot move it');
select is((select count(*)::int from app.fulfillment_state_transitions), 0, 'nor read its ledger');

-- Accommodation blocks ---------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held, nightly_rate_minor, currency_code)
  values (pg_temp.id('prj_a'), 'Harborview Crew Block', '2027-06-01', '2027-06-04', 2, 18900, 'USD') returning id) insert into world select 'blk', id from x;
select is((select app.accommodation_block_display_key(b) from app.accommodation_blocks b where b.id = pg_temp.id('blk')), 'NWL-6', 'a block takes the next display key');
select throws_ok($$insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held, nightly_rate_minor) values ((select id from world where key = 'prj_a'), 'No Currency', '2027-06-01', '2027-06-02', 1, 100)$$,
  '23514', null, 'a rate needs its currency');
select throws_ok($$insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held) values ((select id from world where key = 'prj_a'), 'Backwards', '2027-06-04', '2027-06-01', 1)$$,
  '23514', null, 'check-out follows check-in');
insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on) values (pg_temp.id('blk'), pg_temp.id('dave'), '2027-06-01', '2027-06-04');
insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on) values (pg_temp.id('blk'), pg_temp.id('erin'), '2027-06-01', '2027-06-03');
select is((select org_id from app.accommodation_assignments where person_id = pg_temp.id('erin')), pg_temp.id('org_a'), 'an assignment''s org is derived from its block');
select throws_ok($$insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on) values ((select id from world where key = 'blk'), (select id from world where key = 'frank'), '2027-06-02', '2027-06-03')$$,
  'XR001', null, 'a third guest on a night with both rooms taken is refused (accommodation_block_full)');
select lives_ok($$insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on) values ((select id from world where key = 'blk'), (select id from world where key = 'frank'), '2027-06-03', '2027-06-04')$$,
  'a room freed on the last night takes a new guest');
select throws_ok($$insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on) values ((select id from world where key = 'blk'), (select id from world where key = 'mia'), '2027-05-30', '2027-06-02')$$,
  'XR001', null, 'a stay outside the block is refused');
select throws_ok($$insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on) values ((select id from world where key = 'blk'), (select id from world where key = 'dave'), '2027-06-02', '2027-06-03')$$,
  'XR001', null, 'a guest is never doubled on the same nights');
select throws_ok($$update app.accommodation_blocks set rooms_held = 1 where id = (select id from world where key = 'blk')$$,
  'XR001', 'accommodation_block_full: More rooms are assigned on some night than the block would hold.', 'a block cannot shrink below its assignments');
select throws_ok($$update app.accommodation_blocks set check_out_on = '2027-06-03' where id = (select id from world where key = 'blk')$$,
  'XR001', 'accommodation_block_excludes_stays: The block must still cover every assigned stay.', 'nor stop covering an assigned stay');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'accommodation_assignment.created' and org_id = pg_temp.id('org_a')), 3, 'each assignment emits accommodation_assignment.created');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.accommodation_blocks), 0, 'a Viewer outside the project reads no blocks');
select throws_ok($$insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held) values ((select id from world where key = 'prj_a'), 'Viewer Block', '2027-06-01', '2027-06-02', 1)$$,
  '42501', null, 'and cannot write one');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.accommodation_assignments), 0, 'another org reads no assignments');
select pg_temp.as_anon();
select throws_ok('select 1 from app.accommodation_blocks', '42501', null, 'anon cannot read blocks');
select pg_temp.as_platform();

-- Domain events ----------------------------------------------------------------------------------------------
select is((select count(*)::int from app.domain_events where event_type = 'dock_slot.checked_in' and subject_id = pg_temp.id('slot')), 1, 'a check-in emits dock_slot.checked_in once');
select is((select count(*)::int from app.domain_events where event_type = 'shipment.created' and project_id = pg_temp.id('prj_a')), 2, 'each shipment emits shipment.created with its project');

select * from finish();
rollback;
