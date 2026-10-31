-- pgTAP: migration 2693 (R7), the allocation RPCs. Requests with the offering and cap rules (offering_not_offered,
-- offering_not_provided, both caps), holder rules, the requester separation, a decline needs a reason, approval
-- reserves class stock or asks for sources, mixed supply (four from stock and two on a rental line), splits move
-- quantity and holds and send allocation.assigned, unsplit refuses what was issued, withdraw, and issue for every
-- kind with idempotent replays, reused events, self issue, a person required, the quantity cap, the capability per
-- kind, and a parking pass with the holder's vehicle. Notifications decided, issued and withdrawn.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

insert into world values
  ('ev1', '01920000-0000-7000-8693-000000000001'), ('ev2', '01920000-0000-7000-8693-000000000002'),
  ('ev3', '01920000-0000-7000-8693-000000000003'), ('ev4', '01920000-0000-7000-8693-000000000004'),
  ('ev5', '01920000-0000-7000-8693-000000000005'), ('ev6', '01920000-0000-7000-8693-000000000006'),
  ('ev7', '01920000-0000-7000-8693-000000000007'), ('ev8', '01920000-0000-7000-8693-000000000008'),
  ('ev9', '01920000-0000-7000-8693-000000000009');

create function pg_temp.notified(p_who text, p_kind text, p_subject uuid) returns integer
language sql security definer as $$
  select count(*)::int from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_who) and n.kind = p_kind and n.subject_id = p_subject
$$;

-- Requests ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$select pg_temp.alloc('request', 'gina', 'eng_vendor_a', 'travel', null, 1)$$, '42501', null,
  'a request needs advancing.packet.write');
select throws_ok($$select pg_temp.alloc('request', 'dave', 'e_kai', 'category', 'cat_crew', 1, null, null, '2027-06-05 12:00+00', '2027-06-01 12:00+00')$$,
  'XR001', 'allocation_window: An allocation is needed from a start to a later end.', 'the window runs forward');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'offerings.radios', 'Organization', null, 'not-offered');
select throws_ok($$select pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1)$$, 'XR001',
  'offering_not_offered: Radios is not offered on this engagement''s project.', 'a Not Offered offering refuses (decision 7)');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'offerings.travel', 'Organization', null, 'reimbursed');
select throws_ok($$select pg_temp.alloc('request', 'dave', 'e_kai', 'travel', null, 1)$$, 'XR001',
  'offering_not_provided: Travel is reimbursed here, so it is not allocated.', 'a Reimbursed travel offering refuses offering_not_provided');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'offerings.travel', 'Organization', null, 'provided');
select app.set_setting(pg_temp.id('org_a'), 'offerings.radios', 'Organization', null, 'provided');
insert into app.offering_rules (org_id, project_id, offering, offering_mode, cap_per_engagement, cap_per_person)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Radios', 'Provided', 6, 2);
select throws_ok($$select pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 3)$$, 'XR001',
  'allocation_cap_person: This person may have 2 of this; the request goes beyond it.', 'the cap per person');
select throws_ok($$select pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_radio', 7)$$, 'XR001',
  'allocation_cap_engagement: This engagement may have 6 of this; the request goes beyond it.', 'the cap per engagement');
select lives_ok($$select pg_temp.alloc('request', 'dave', 'e_una', 'category', 'cat_crew', 1)$$, 'a Draft entry may be requested for');
select pg_temp.as_user('una');
select app.respond_roster_entry(pg_temp.id('e_una'), 'Declined');
select throws_ok($$select pg_temp.alloc('request', 'dave', 'e_una', 'class', 'cls_radio', 1)$$, 'XR001',
  'allocation_entry_not_live: The roster entry was withdrawn or declined.', 'a declined entry is not');
select throws_ok($$select pg_temp.alloc('request', 'dave', 'eng_ivy_b', 'class', 'cls_radio', 1)$$, 'XR001',
  'allocation_holder_project: An allocation''s holder is an engagement of the project.', 'the holder is on the project');

-- The pool: six radios for Bayside Audio.
insert into world select 'pool', pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_radio', 6, 'For the audio crew.');
select is(pg_temp.state_of(pg_temp.id('pool')), 'Requested', 'a request starts Requested');
select pg_temp.as_platform();
select is((select origin::text || ' ' || created_by::text from app.advance_allocations where id = pg_temp.id('pool')),
  'Requested ' || pg_temp.id('dave')::text, 'with origin Requested and the requester stamped');
select is(private.allocation_requester(pg_temp.id('pool')), pg_temp.id('dave'), 'the requester is computed from created_by');
select throws_ok($$select pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 1)$$, 'XR001',
  'allocation_cap_engagement: This engagement may have 6 of this; the request goes beyond it.', 'requests under the pool count toward its cap');

-- Deciding ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved')$$, pg_temp.id('pool')), 'XR001',
  'sod_allocation_requester: The person who requested an allocation cannot approve or decline it.', 'the requester cannot approve');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved')$$, pg_temp.id('pool')), '42501', null,
  'deciding needs advancing.submission.review');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.decide_allocation(%L, 'Rejected', ' ')$$, pg_temp.id('pool')), 'XR001',
  'allocation_reason_required: Say why the allocation is declined, in 1 to 1000 characters.', 'a decline needs a reason');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved', null, '[{"source": "Class Stock", "quantity": 6}]')$$, pg_temp.id('pool')),
  'XR001', 'reservation_over_capacity: Not enough of this class is free in that window.', 'six from stock is more than four radios');
-- Mixed supply: four from stock and two on the rental line.
select ok(app.decide_allocation(pg_temp.id('pool'), 'Approved', null, jsonb_build_array(
    jsonb_build_object('source', 'Class Stock', 'quantity', 4),
    jsonb_build_object('source', 'Order Line', 'po_line_id', pg_temp.id('l_rent'), 'quantity', 2))),
  'a reviewer approves with four from stock and two on the rental line');
select is(pg_temp.holds(pg_temp.id('pool')), 'line:2,stock:4', 'two holds, one per source');
select is(pg_temp.notified('dave', 'allocation.decided', pg_temp.id('pool')), 1, 'the requester hears of the decision');
select throws_ok(format($$select app.decide_allocation(%L, 'Rejected', 'Late.')$$, pg_temp.id('pool')), 'XR001',
  'allocation_state_conflict: The allocation is Approved already.', 'a decision is compare-and-set');

insert into world select 'decl', pg_temp.alloc('request', 'dave', 'e_kai', 'category', 'cat_crew', 1);
select pg_temp.as_user('carol');
select app.decide_allocation(pg_temp.id('decl'), 'Rejected', 'Kai already has a badge.');
select pg_temp.as_platform();
select is((select to_state::text || ': ' || reason from app.advance_allocation_state_transitions
           where advance_allocation_id = pg_temp.id('decl') and to_state = 'Declined'), 'Declined: Kai already has a badge.',
  'the decline reason is in the ledger');

insert into world select 'nosrc', pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_cable', 10);
select pg_temp.as_platform();
insert into app.venues (org_id, name, jurisdiction_id, time_zone)
values (pg_temp.id('org_a'), 'Northwind Warehouse', 'US-FL-MIAMI-DADE', 'America/New_York');
insert into app.asset_lots (asset_class_id, venue_id, quantity)
select pg_temp.id('cls_cable'), v.id, 20 from app.venues v where v.name = 'Northwind Warehouse';
select pg_temp.as_user('carol');
select throws_ok(format($$select app.decide_allocation(%L, 'Approved')$$, pg_temp.id('nosrc')), 'XR001',
  'allocation_sources_required: Say where the stock comes from: class stock, a lot or an order line.',
  'with two lots and no units the reviewer names the source');

-- Assigning --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select pg_temp.alloc('assign', 'gina', 'e_kai', 'category', 'cat_crew', 1)$$, '42501', null,
  'assigning needs advancing.submission.review');
select throws_ok($$select pg_temp.alloc('assign', 'carol', 'e_una', 'category', 'cat_crew', 1)$$, 'XR001',
  'allocation_entry_not_accepted: The roster entry is accepted by the reviewer and the person first.', 'an assignment goes to an accepted entry');
insert into world select 'badge', pg_temp.alloc('assign', 'carol', 'e_kai', 'category', 'cat_crew', 1);
select is(pg_temp.state_of(pg_temp.id('badge')), 'Approved', 'an assignment is Approved at once');
select pg_temp.as_platform();
select is((select string_agg(coalesce(from_state::text, '-') || '>' || to_state, ',' order by created_at, id)
           from app.advance_allocation_state_transitions where advance_allocation_id = pg_temp.id('badge')),
  '->Requested,Requested>Approved', 'inserted Requested and moved to Approved in the same call');
select is((select origin::text from app.advance_allocations where id = pg_temp.id('badge')), 'Assigned', 'origin Assigned');
select is(pg_temp.notified('kai', 'allocation.decided', pg_temp.id('badge')), 1, 'the person hears of it');

-- Splitting ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$select app.split_allocation(%L, jsonb_build_array(jsonb_build_object('roster_entry_id', %L, 'quantity', 1)))$$,
  pg_temp.id('badge'), pg_temp.id('e_mo')), 'XR001',
  'allocation_not_pool: Only an approved allocation held by a party is split to its people.', 'only a pool is split');
select throws_ok(format($$select app.split_allocation(%L, jsonb_build_array(jsonb_build_object('roster_entry_id', %L, 'quantity', 3)))$$,
  pg_temp.id('pool'), pg_temp.id('e_mo')), 'XR001',
  'allocation_cap_person: This person may have 2 of this; the request goes beyond it.', 'a split stays within the cap per person');
select throws_ok(format($$select app.split_allocation(%L, jsonb_build_array(jsonb_build_object('roster_entry_id', %L, 'quantity', 2),
    jsonb_build_object('roster_entry_id', %L, 'quantity', 2), jsonb_build_object('roster_entry_id', %L, 'quantity', 2),
    jsonb_build_object('roster_entry_id', %L, 'quantity', 1)))$$,
  pg_temp.id('pool'), pg_temp.id('e_kai'), pg_temp.id('e_mo'), pg_temp.id('self_sam'), pg_temp.id('e_kai')), 'XR001',
  'allocation_split_exceeds: A split gives no more than the pool has left.', 'a split gives no more than the pool');
select throws_ok(format($$select app.split_allocation(%L, jsonb_build_array(jsonb_build_object('roster_entry_id', %L, 'quantity', 1)))$$,
  pg_temp.id('pool'), pg_temp.id('e_una')), 'XR001',
  'allocation_entry_not_accepted: The roster entry is accepted by the reviewer and the person first.', 'a split goes to accepted entries');
insert into world select 'kai_radios', (app.split_allocation(pg_temp.id('pool'), jsonb_build_array(
  jsonb_build_object('roster_entry_id', pg_temp.id('e_kai'), 'quantity', 2, 'asset_unit_ids', jsonb_build_array(pg_temp.id('r1'))))))[1];
select pg_temp.as_platform();
select is((select quantity from app.advance_allocations where id = pg_temp.id('pool')), 4::numeric, 'the pool keeps four');
select is((select origin::text || ' ' || allocation_state::text || ' ' || (parent_allocation_id = pg_temp.id('pool'))::text
           from app.advance_allocations where id = pg_temp.id('kai_radios')), 'Split Approved true', 'Kai''s share is an approved split');
select is(pg_temp.holds(pg_temp.id('kai_radios')), 'stock:1,unit:1', 'the named radio pinned, the rest from class stock');
select is(pg_temp.holds(pg_temp.id('pool')), 'line:2,stock:2', 'the pool''s stock hold went down by two');
select is(pg_temp.notified('kai', 'allocation.assigned', pg_temp.id('kai_radios')), 1, 'allocation.assigned reaches Kai');

-- Issuing ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$select app.issue_allocation(null, %L, '[{}]')$$, pg_temp.id('badge')), 'XR001',
  'issue_event_required: Every issue carries the event id it was recorded under.', 'an issue carries its event id');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.issue_allocation(%L, %L, '[{}]')$$, pg_temp.id('ev1'), pg_temp.id('badge')), '42501',
  'credentials.credential.issue is required', 'a badge needs credentials.credential.issue');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.issue_allocation(%L, %L, '[{"asset_tag": "NWL-RAD-001"}]')$$, pg_temp.id('ev1'), pg_temp.id('kai_radios')),
  '42501', 'assets.custody.write is required', 'a radio needs assets.custody.write');
select pg_temp.as_user('kai');
select throws_ok(format($$select app.issue_allocation(%L, %L, '[{}]')$$, pg_temp.id('ev1'), pg_temp.id('badge')), '42501', null,
  'the holder holds no issue capability');

select pg_temp.as_user('carol');
select is((app.issue_allocation(pg_temp.id('ev1'), pg_temp.id('badge'), '[{}]')) ->> 'outcome', 'applied', 'Carol issues Kai''s badge');
select pg_temp.as_platform();
select is((select holder_person_id::text || ' ' || engagement_id::text || ' ' || issued_by::text from app.credentials where allocation_id = pg_temp.id('badge')),
  pg_temp.id('kai')::text || ' ' || pg_temp.id('eng_vendor_a')::text || ' ' || pg_temp.id('carol')::text,
  'the badge is Kai''s, under the vendor engagement, issued by Carol (a rostered person passes credential_engagement_holder)');
select is((select valid_from from app.credentials where allocation_id = pg_temp.id('badge')), '2027-06-01 12:00+00'::timestamptz,
  'valid from the window''s start');
select pg_temp.as_user('carol');
select is((app.issue_allocation(pg_temp.id('ev1'), pg_temp.id('badge'), '[{}]')) ->> 'outcome', 'duplicate', 'a replay is a duplicate');
select pg_temp.as_platform();
select is((select count(*)::int from app.credentials where allocation_id = pg_temp.id('badge')), 1, 'and writes nothing twice');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.issue_allocation(%L, %L, '[{"asset_tag": "NWL-RAD-001"}]')$$, pg_temp.id('ev1'), pg_temp.id('kai_radios')),
  'XR001', 'issue_event_reused: This issue event already issued another allocation.', 'an event id issues one allocation');
-- A second badge in another window is beyond the quantity; one for the same window is a duplicate badge (B8, 2973).
select throws_ok(format($$select app.issue_allocation(%L, %L, '[{"valid_from": "2028-01-01T00:00:00Z", "valid_to": "2028-01-02T00:00:00Z"}]')$$,
    pg_temp.id('ev2'), pg_temp.id('badge')), 'XR001',
  'allocation_issue_exceeds: This allocation is for 1; the issue goes beyond it.', 'never more than the quantity');
select throws_ok(format($$select app.issue_allocation(%L, %L, '[{}]')$$, pg_temp.id('ev2'), pg_temp.id('badge')), 'XR001',
  'credential_duplicate: This person already holds a live credential of this category for an overlapping window. Revoke the earlier credential first, or change the window.',
  'and a second badge for the same window is a duplicate');
select is(pg_temp.notified('kai', 'allocation.issued', pg_temp.id('badge')), 1, 'allocation.issued reaches Kai');

-- Radios by tag, against the holds.
select is((app.issue_allocation(pg_temp.id('ev3'), pg_temp.id('kai_radios'), '[{"asset_tag": "nwl-rad-001"}]')) ->> 'outcome', 'applied',
  'the pinned radio goes to Kai by tag');
select pg_temp.as_platform();
select is((select custodian_engagement_id::text || ' ' || roster_entry_id::text from app.asset_custody where id = (
  select (possession -> 'asset_custody' ->> 0)::uuid from app.advance_issue_events where id = pg_temp.id('ev3'))),
  pg_temp.id('eng_vendor_a')::text || ' ' || pg_temp.id('e_kai')::text, 'custody to the engagement with Kai''s entry');
select is((select asset_state::text from app.asset_units where id = pg_temp.id('r1')), 'Deployed', 'the radio is Deployed');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.issue_allocation(%L, %L, '[{"asset_tag": "NWL-RAD-002"}, {"asset_tag": "NWL-RAD-003"}]')$$,
  pg_temp.id('ev4'), pg_temp.id('kai_radios')), 'XR001', null, 'two more radios exceed Kai''s two');
select is((app.issue_allocation(pg_temp.id('ev4'), pg_temp.id('kai_radios'), '[{"asset_tag": "NWL-RAD-002"}]')) ->> 'outcome', 'applied',
  'the second radio from class stock');

-- A pool asset goes to the party; other kinds need a person.
insert into world select 'pool_badges', pg_temp.alloc('assign', 'carol', 'eng_vendor_a', 'category', 'cat_crew', 3);
select pg_temp.as_user('carol');
select throws_ok(format($$select app.issue_allocation(%L, %L, '[{}]')$$, pg_temp.id('ev5'), pg_temp.id('pool_badges')), 'XR001',
  'allocation_needs_person: This item goes to one person; split the allocation to the people first.', 'a pool of badges is split first');

-- Self issue.
select pg_temp.as_platform();
select pg_temp.join_org('bob', 'org_a', 'kai', 'manager');
insert into world select 'kai_trip', pg_temp.alloc('assign', 'carol', 'e_kai', 'travel', null, 1);
select pg_temp.as_user('kai');
select throws_ok(format($$select app.issue_allocation(%L, %L, '[{"travel_mode": "Flight", "departs_from": "BOS", "departs_at": "2027-06-01T08:00:00Z", "departs_time_zone": "America/New_York", "arrives_at_place": "MIA", "arrives_time_zone": "America/New_York"}]')$$,
  pg_temp.id('ev6'), pg_temp.id('kai_trip')), 'XR001', 'allocation_self_issue: A person never issues an allocation to themselves.',
  'a person never issues to themselves');
select pg_temp.as_user('carol');
select is((app.issue_allocation(pg_temp.id('ev6'), pg_temp.id('kai_trip'), '[{"travel_mode": "Flight", "departs_from": "BOS", "departs_at": "2027-06-01T08:00:00Z", "departs_time_zone": "America/New_York", "arrives_at_place": "MIA", "arrives_time_zone": "America/New_York"}]')) ->> 'outcome',
  'applied', 'a trip is issued as a travel segment');
select pg_temp.as_platform();
select is((select engagement_id from app.travel_segments where allocation_id = pg_temp.id('kai_trip')), pg_temp.id('eng_vendor_a'),
  'under the entry''s engagement');

-- Lodging, catering and per diem.
insert into world select 'kai_room', pg_temp.alloc('assign', 'carol', 'e_kai', 'block', 'blk', 1);
insert into world select 'kai_meals', pg_temp.alloc('assign', 'carol', 'e_kai', 'fulfillment', 'ful_cat', 4);
insert into world select 'kai_pd', pg_temp.alloc('assign', 'carol', 'e_kai', 'per_diem', null, 4);
select pg_temp.as_user('carol');
select app.issue_allocation(pg_temp.id('ev7'), pg_temp.id('kai_room'), '[{}]');
select pg_temp.as_platform();
select is((select check_in_on::text || ' ' || check_out_on::text from app.accommodation_assignments where allocation_id = pg_temp.id('kai_room')),
  '2027-06-01 2027-06-05', 'a room defaults to the window''s days in its time zone');
select pg_temp.as_user('carol');
select app.issue_allocation(pg_temp.id('ev8'), pg_temp.id('kai_meals'), '[{"quantity": 2}]');
select pg_temp.as_platform();
select is((select description || ' ' || quantity from app.fulfillment_lines where allocation_id = pg_temp.id('kai_meals')), 'Crew Catering 2',
  'catering lines for the person');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.issue_allocation(%L, %L, '[{"day": "2027-06-09", "amount_minor": 5000, "currency_code": "USD"}]')$$,
  pg_temp.id('ev9'), pg_temp.id('kai_pd')), 'XR001', 'issue_day_outside_window: A per diem day falls inside the allocation''s window.',
  'per diem days fall inside the window');
select is((app.issue_allocation(pg_temp.id('ev9'), pg_temp.id('kai_pd'), '[{"day": "2027-06-01", "amount_minor": 5000, "currency_code": "USD"}, {"day": "2027-06-02", "amount_minor": 5000, "currency_code": "USD"}]')) ->> 'outcome',
  'applied', 'two per diem days');
select pg_temp.as_platform();
select is((select count(*)::int from app.per_diems where allocation_id = pg_temp.id('kai_pd') and roster_entry_id = pg_temp.id('e_kai') and engagement_id is null),
  2, 'a roster per diem names the entry with engagement_id NULL and passes per_diems_one_worker');

-- Capability per kind.
select pg_temp.as_user('gina');
select throws_ok(format($$select app.issue_allocation(%L, %L, '[{}]')$$, pg_temp.id('ev5'), pg_temp.id('kai_room')), '42501',
  'hospitality.accommodation.write is required', 'lodging needs hospitality.accommodation.write');
select throws_ok(format($$select app.issue_allocation(%L, %L, '[{}]')$$, pg_temp.id('ev5'), pg_temp.id('kai_meals')), '42501',
  'hospitality.fulfillment.write is required', 'catering needs hospitality.fulfillment.write');
select throws_ok(format($$select app.issue_allocation(%L, %L, '[{}]')$$, pg_temp.id('ev5'), pg_temp.id('kai_pd')), '42501',
  'crew.time_entry.write is required', 'per diem needs crew.time_entry.write');

-- A parking pass with Kai's vehicle.
select pg_temp.as_user('kai');
select app.save_roster_vehicle(pg_temp.id('e_kai'), 'Ford', 'Transit', 'White', 'ABC1234', 'US-FL');
insert into world select 'kai_car', id from app.roster_vehicles where roster_entry_id = pg_temp.id('e_kai');
insert into world select 'kai_park', pg_temp.alloc('assign', 'carol', 'e_kai', 'category', 'cat_park', 1);
select pg_temp.as_user('carol');
select throws_ok(format($$select app.issue_allocation(%L, %L, jsonb_build_array(jsonb_build_object('roster_vehicle_id', %L)))$$,
  pg_temp.id('ev2'), pg_temp.id('badge'), pg_temp.id('kai_car')), 'XR001', null, 'only a pass names a vehicle');
select is((app.issue_allocation(pg_temp.id('ev5'), pg_temp.id('kai_park'), jsonb_build_array(jsonb_build_object('roster_vehicle_id', pg_temp.id('kai_car'))))) ->> 'outcome',
  'applied', 'the pass is issued for Kai''s vehicle');
select pg_temp.as_platform();
select is((select v.roster_vehicle_id from app.credential_vehicles v join app.credentials c on c.id = v.credential_id
           where c.allocation_id = pg_temp.id('kai_park')), pg_temp.id('kai_car'), 'the pass links the vehicle, never the plate');

-- Unsplit and withdraw ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$select app.unsplit_allocation(%L)$$, pg_temp.id('kai_radios')), 'XR001',
  'allocation_issued: Part of this share was issued; only what was not issued goes back.', 'an issued share does not go back');
insert into world select 'mo_radio', (app.split_allocation(pg_temp.id('pool'), jsonb_build_array(
  jsonb_build_object('roster_entry_id', pg_temp.id('e_mo'), 'quantity', 1))))[1];
select is(app.unsplit_allocation(pg_temp.id('mo_radio')), 1::numeric, 'an unissued share goes back whole');
select pg_temp.as_platform();
select is((select allocation_state::text || ' ' || withdraw_cause::text from app.advance_allocations where id = pg_temp.id('mo_radio')),
  'Withdrawn Reviewer', 'and is Withdrawn by the reviewer');
select is((select quantity from app.advance_allocations where id = pg_temp.id('pool')), 4::numeric, 'the pool has four again');
select is(pg_temp.holds(pg_temp.id('pool')), 'line:2,stock:2', 'with its holds');

select pg_temp.as_user('carol');
select throws_ok(format($$select app.withdraw_allocation(%L, 'No longer needed.')$$, pg_temp.id('kai_radios')), 'XR001',
  'allocation_issued: Something of this allocation is out; check it in or revoke it first.', 'nothing out is withdrawn');
insert into world select 'w1', pg_temp.alloc('request', 'dave', 'e_mo', 'category', 'cat_crew', 1);
select pg_temp.as_user('gina');
select throws_ok(format($$select app.withdraw_allocation(%L)$$, pg_temp.id('w1')), '42501', null, 'a stranger withdraws nothing');
select pg_temp.as_user('dave');
select app.withdraw_allocation(pg_temp.id('w1'), 'Asked twice.');
select pg_temp.as_platform();
select is((select allocation_state::text || ' ' || withdraw_cause::text from app.advance_allocations where id = pg_temp.id('w1')),
  'Withdrawn Requester', 'the requester withdraws their own request');
select is(pg_temp.notified('mo', 'allocation.withdrawn', pg_temp.id('w1')), 1, 'allocation.withdrawn reaches Mo');

-- Releasing a hold.
select pg_temp.as_user('carol');
select throws_ok(format($$select app.release_reservation(%L)$$, (select id from app.asset_reservations where advance_allocation_id = pg_temp.id('kai_radios') and asset_unit_id is not null)),
  'XR001', 'reservation_in_use: Something issued against this hold is still out; check it in first.', 'a hold with a radio out stays');
select lives_ok(format($$select app.release_reservation(%L, 'Ordering more instead.')$$,
  (select id from app.asset_reservations where advance_allocation_id = pg_temp.id('pool') and po_line_id is not null)),
  'a reviewer releases the rental hold');
select pg_temp.as_platform();
select is(pg_temp.holds(pg_temp.id('pool')), 'stock:2', 'it no longer holds');
select is((select release_reason::text from app.asset_reservations where advance_allocation_id = pg_temp.id('pool') and po_line_id is not null),
  'Released By Reviewer', 'released by the reviewer');

select ok(exists (select 1 from private.sync_rpcs where rpc = 'app.issue_allocation'), 'issue is a sync RPC');

select * from finish();
rollback;
