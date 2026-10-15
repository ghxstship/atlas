-- pgTAP: A11 travel segments and field RPCs (migration 0442). Travel RLS (same tenant, cross tenant,
-- anon, role bands), the Travel fulfillment rule, zones, unpriced fares, events, and the Compass RPCs
-- with their refusals and their sync allowlist entries.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(24);

-- Travel segments -----------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.fulfillments (project_id, fulfillment_kind, title) values (pg_temp.id('prj_a'), 'Travel', 'Crew Flights') returning id) insert into world select 'trv', id from x;
with x as (insert into app.fulfillments (project_id, fulfillment_kind, title) values (pg_temp.id('prj_a'), 'Catering', 'Crew Meals') returning id) insert into world select 'cat', id from x;
with x as (insert into app.travel_segments (project_id, person_id, fulfillment_id, travel_mode, operator_name, service_identifier,
    departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_at, arrives_time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('frank'), pg_temp.id('trv'), 'Flight', 'Coastal Air', 'CA 214',
    'BOS', '2027-05-31 12:00+00', 'America/New_York', 'MIA', '2027-05-31 15:20+00', 'America/New_York') returning id) insert into world select 'seg', id from x;
select is((select org_id from app.travel_segments where id = pg_temp.id('seg')), pg_temp.id('org_a'), 'a segment''s org is derived from its project');
select is((select price_minor from app.travel_segments where id = pg_temp.id('seg')), null::bigint, 'a segment without a fare stays unpriced, never zero');
select throws_ok($$insert into app.travel_segments (project_id, person_id, fulfillment_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_time_zone)
  values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank'), (select id from world where key = 'cat'), 'Ground', 'MIA', now(), 'America/New_York', 'Hotel', 'America/New_York')$$,
  'XR001', 'travel_fulfillment_kind: A travel segment belongs to a Travel fulfillment.', 'a segment belongs only to a Travel fulfillment');
select throws_ok($$insert into app.travel_segments (project_id, person_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_time_zone)
  values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank'), 'Ground', 'MIA', now(), 'Mars/Olympus', 'Hotel', 'America/New_York')$$,
  'XR001', null, 'zones are IANA zones');
select throws_ok($$insert into app.travel_segments (project_id, person_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_at, arrives_time_zone)
  values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank'), 'Ground', 'MIA', '2027-06-01 12:00+00', 'UTC', 'Hotel', '2027-06-01 11:00+00', 'UTC')$$,
  '23514', null, 'arrival never precedes departure');
select throws_ok($$insert into app.travel_segments (project_id, person_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_time_zone, price_minor)
  values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank'), 'Ground', 'MIA', now(), 'UTC', 'Hotel', 'UTC', 4500)$$,
  '23514', null, 'a fare needs its currency');
select throws_ok($$insert into app.travel_segments (project_id, person_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_time_zone)
  values ((select id from world where key = 'prj_a2'), (select id from world where key = 'frank'), 'Ground', 'MIA', now(), 'UTC', 'Hotel', 'UTC')$$,
  '42501', null, 'a Member cannot write travel on a project they are not on');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.travel_segments), 1, 'a Field project member reads the project''s travel');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.travel_segments), 0, 'a Viewer outside the project reads no travel');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.travel_segments), 0, 'another org reads no travel');
select pg_temp.as_anon();
select throws_ok('select 1 from app.travel_segments', '42501', null, 'anon cannot read travel');
select pg_temp.as_user('dave');
update app.travel_segments set deleted_at = now() where id = pg_temp.id('seg');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where subject_id = pg_temp.id('seg') and event_type in ('travel_segment.created', 'travel_segment.canceled')), 2, 'booking and cancelling emit events');

-- Field RPCs --------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DOCK-F', 'Field Dock') returning id) insert into world select 'dock', id from x;
select pg_temp.as_user('dave');
with x as (insert into app.dock_slots (project_id, zone_id, starts_at, ends_at) values (pg_temp.id('prj_a'), pg_temp.id('dock'), '2027-06-01 06:00+00', '2027-06-01 08:00+00') returning id) insert into world select 'slot', id from x;
select pg_temp.as_user('frank');
select ok(app.check_in_dock_slot(pg_temp.id('slot')) is not null, 'a Field member checks in through the RPC');
select throws_ok($$select app.check_in_dock_slot((select id from world where key = 'slot'))$$,
  'XR001', 'dock_slot_not_open: This dock slot is already checked in, canceled or not yours to change.', 'a second check-in is refused');
insert into world select 'gq', app.record_gate_arrival(pg_temp.id('prj_a'), ' FL-TRK-9 ', null);
select is((select vehicle_identifier from app.gate_queue where id = pg_temp.id('gq')), 'FL-TRK-9', 'an arrival is recorded and trimmed');
select throws_ok($$select app.release_vehicle((select id from world where key = 'gq'))$$, '42501', null, 'a Field member cannot release a vehicle');
select pg_temp.as_user('dave');
select ok(app.release_vehicle(pg_temp.id('gq')) is not null, 'a Member with release authority releases it');
select throws_ok($$select app.release_vehicle((select id from world where key = 'gq'))$$,
  'XR001', 'vehicle_not_waiting: This vehicle is already released or not yours to release.', 'a second release is refused');
select ok(app.add_marshalling_entry(pg_temp.id('prj_a'), 'Truck staged in lane 2.') is not null, 'a yard entry is appended through the RPC');
select pg_temp.as_user('gina');
select throws_ok($$select app.add_marshalling_entry((select id from world where key = 'prj_a'), 'Viewer entry.')$$, '42501', null, 'a Viewer cannot append to the yard log');
select pg_temp.as_user('xavier');
select throws_ok($$select app.record_gate_arrival((select id from world where key = 'prj_a'), 'XB-1')$$, '42501', null, 'another org cannot record arrivals');
select pg_temp.as_anon();
select throws_ok($$select app.check_in_dock_slot((select id from world where key = 'slot'))$$, '42501', null, 'anon cannot call the field RPCs');
select pg_temp.as_platform();
select is((select count(*)::int from private.sync_rpcs where rpc in ('app.check_in_dock_slot', 'app.record_gate_arrival', 'app.release_vehicle', 'app.add_marshalling_entry', 'app.transition_fulfillment')), 5,
  'the field RPCs are allowlisted for offline replay');
select is((select count(*)::int from private.domain_event_types where code like 'travel_segment.%'), 2, 'travel events are catalogued');

select * from finish();
rollback;
