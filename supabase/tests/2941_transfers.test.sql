-- pgTAP: migration 2941 (B5, G-33), ground transfers. A transfer with a driver, a vehicle and passengers is created,
-- edited, canceled and restored; each refusal names its rule: a driver, vehicle or passenger booked twice at once
-- (including a driver who rides elsewhere, a window moved onto a passenger's other transfer and a restore that collides),
-- a full vehicle (adding a passenger, switching to a smaller vehicle, or cutting its seats), the driver as a passenger,
-- a person not on the project, a fulfillment that is not Travel, a met segment that is not a Flight of the project. A
-- second primary passenger is refused by the unique index. The display key, numbers, Trash registration and events.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 2940_travel_world.psql

select no_plan();

-- A transfer with dave driving the van, kai riding as primary -------------------------------------------------------------
select pg_temp.transfer('t1', '2027-06-02 14:00+00', '2027-06-02 15:00+00', 'dave', 'van');
select pg_temp.ride('t1', 'kai', true);
select is((select count(*)::int from app.transfer_passengers where transfer_id = pg_temp.id('t1') and deleted_at is null), 1,
  'a transfer takes a passenger');
select is((select app.transfer_display_key(t) from app.transfers t where t.id = pg_temp.id('t1')),
  'NWL-' || (select transfer_number from app.transfers where id = pg_temp.id('t1'))::text, 'the display key is {project_key}-{number}');
select ok((select transfer_number from app.transfers where id = pg_temp.id('t1')) > 0, 'the number comes from the project sequence');
select is((select count(*)::int from app.domain_events where event_type = 'transfer.created' and subject_id = pg_temp.id('t1')), 1,
  'transfer.created is emitted');

-- Who may ride and drive -----------------------------------------------------------------------------------------------------
select is(pg_temp.rule_of(format($$select pg_temp.ride(%L, 'quinn')$$, 't1')), 'transfer_person_not_on_project',
  'a person with no link to the project cannot ride');
select is(pg_temp.rule_of($$select pg_temp.transfer('tq', '2027-06-03 14:00+00', '2027-06-03 15:00+00', 'quinn', null)$$),
  'transfer_person_not_on_project', 'nor drive');
select is(pg_temp.rule_of($$select pg_temp.ride('t1', 'dave')$$), 'transfer_driver_is_passenger', 'the driver cannot ride');
select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.transfers set driver_person_id = %L where id = %L$$,
  pg_temp.id('kai'), pg_temp.id('t1'))), 'transfer_driver_is_passenger', 'nor can a passenger become the driver');
select pg_temp.as_platform();
select is(pg_temp.rule_of($$select pg_temp.ride('t1', 'mo', true)$$), '23505', 'a second primary passenger is refused');
select is(pg_temp.rule_of($$select pg_temp.ride('t1', 'una')$$), 'ok', 'a Draft roster person on the project may ride');

-- Seats -------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.rule_of($$select pg_temp.ride('t1', 'mo')$$), 'transfer_vehicle_full', 'the van seats two');
select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.transfers set vehicle_id = %L where id = %L$$,
  pg_temp.id('sedan'), pg_temp.id('t1'))), 'transfer_vehicle_full', 'switching to the sedan with two riders is refused');
select pg_temp.as_platform();
select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.transfer_vehicles set seats = 1 where id = %L$$,
  pg_temp.id('van'))), 'transfer_vehicle_full', 'so is cutting the van to one seat');
select pg_temp.as_platform();

-- Double booking ----------------------------------------------------------------------------------------------------------------
select is(pg_temp.rule_of($$select pg_temp.transfer('t2', '2027-06-02 14:30+00', '2027-06-02 15:30+00', 'dave', 'sedan')$$),
  'transfer_driver_double_booked', 'the driver is refused on an overlapping transfer');
select is(pg_temp.rule_of($$select pg_temp.transfer('t2', '2027-06-02 14:30+00', '2027-06-02 15:30+00', 'erin', 'van')$$),
  'transfer_vehicle_double_booked', 'the vehicle is refused on an overlapping transfer');
select pg_temp.transfer('t3', '2027-06-02 14:30+00', '2027-06-02 15:30+00', 'erin', 'sedan');
select is(pg_temp.rule_of($$select pg_temp.ride('t3', 'kai')$$), 'transfer_passenger_double_booked',
  'a passenger is refused on an overlapping transfer');
select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.transfers set driver_person_id = %L where id = %L$$,
  pg_temp.id('una'), pg_temp.id('t3'))), 'transfer_driver_double_booked', 'a driver who rides elsewhere at the time is refused');
select pg_temp.as_platform();
select is(pg_temp.rule_of($$select pg_temp.ride('t3', 'dave')$$), 'transfer_passenger_double_booked',
  'and a person driving elsewhere cannot ride');
select pg_temp.transfer('t4', '2027-06-02 16:00+00', '2027-06-02 17:00+00', 'erin', null);
select pg_temp.ride('t4', 'mo');
select is(pg_temp.rule_of($$select pg_temp.transfer('t5', '2027-06-02 16:30+00', '2027-06-02 17:30+00', null, null)$$), 'ok',
  'an unassigned transfer may overlap');
select pg_temp.ride('t5', 'sam');
select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.transfers set pickup_at = '2027-06-02 13:00+00',
  dropoff_at = '2027-06-02 13:50+00' where id = %L$$, pg_temp.id('t5'))), 'ok', 'moving the window clear of everyone is allowed');
select pg_temp.as_platform();
select pg_temp.ride('t5', 'mo');
select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.transfers set pickup_at = '2027-06-02 16:05+00',
  dropoff_at = '2027-06-02 16:50+00' where id = %L$$, pg_temp.id('t5'))), 'transfer_passenger_double_booked',
  'moving the window onto a passenger''s other transfer is refused');
select pg_temp.as_platform();

-- Cancel and restore -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
update app.transfers set deleted_at = now() where id = pg_temp.id('t4');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'transfer.canceled' and subject_id = pg_temp.id('t4')), 1,
  'transfer.canceled is emitted');
select is(pg_temp.rule_of($$select pg_temp.ride('t4', 'kai')$$), 'transfer_canceled', 'a canceled transfer takes no passengers');
select pg_temp.as_user('alice');
update app.transfers set pickup_at = '2027-06-02 16:05+00', dropoff_at = '2027-06-02 16:50+00' where id = pg_temp.id('t5');
select pg_temp.as_platform();
select is((select pickup_at from app.transfers where id = pg_temp.id('t5')), '2027-06-02 16:05+00'::timestamptz,
  'with t4 canceled, mo is free and the window moves');
select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.transfers set deleted_at = null where id = %L$$,
  pg_temp.id('t4'))), 'transfer_passenger_double_booked', 'restoring t4 now collides with mo''s ride on t5');
select pg_temp.as_platform();
select pg_temp.as_user('alice');
update app.transfers set deleted_at = now() where id = pg_temp.id('t5');
update app.transfers set deleted_at = null where id = pg_temp.id('t4');
select pg_temp.as_platform();
select is((select deleted_at from app.transfers where id = pg_temp.id('t4')), null, 'once t5 is canceled, t4 is restored in place');

-- Fulfillment and met flight -----------------------------------------------------------------------------------------------------
select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.transfers set fulfillment_id = %L where id = %L$$,
  pg_temp.id('ful_cat'), pg_temp.id('t1'))), 'travel_fulfillment_kind', 'a Catering fulfillment is refused');
select pg_temp.as_platform();
select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.transfers set fulfillment_id = %L where id = %L$$,
  pg_temp.id('ful_trv'), pg_temp.id('t1'))), 'ok', 'a Travel fulfillment is taken');
select pg_temp.as_platform();
select pg_temp.as_user('alice');
with x as (insert into app.travel_segments (project_id, person_id, travel_mode, departs_from, departs_at, departs_time_zone,
  arrives_at_place, arrives_time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('kai'), 'Ground', 'MIA', '2027-06-02 12:00+00', 'America/New_York', 'Hotel', 'America/New_York')
  returning id)
insert into world select 'ground', id from x;
select pg_temp.as_platform();
select pg_temp.flight('fl', 'kai', 'NW101', 'LHR', '2027-06-02 05:00+00', 'MIA', '2027-06-02 13:30+00');
select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.transfers set meets_travel_segment_id = %L where id = %L$$,
  pg_temp.id('ground'), pg_temp.id('t1'))), 'transfer_meets_flight', 'a Ground segment is not a flight to meet');
select pg_temp.as_platform();
select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.transfers set meets_travel_segment_id = %L where id = %L$$,
  pg_temp.id('fl'), pg_temp.id('t1'))), 'ok', 'a Flight of the project is');
select pg_temp.as_platform();
select is(pg_temp.rule_of($$select pg_temp.as_user('alice'); update app.transfers set pickup_time_zone = 'Mars/Olympus' where id = pg_temp.id('t1')$$),
  'time_zone_unknown', 'zones are IANA zones');
select pg_temp.as_platform();

-- Writers, Trash and the driver event --------------------------------------------------------------------------------------------
select pg_temp.as_user('hops');
select is(pg_temp.rule_of($$insert into app.transfers (project_id, pickup_place, pickup_at, pickup_time_zone, dropoff_place, dropoff_at,
  dropoff_time_zone) values (pg_temp.id('prj_a'), 'A', now(), 'UTC', 'B', now() + interval '1 hour', 'UTC')$$), '42501',
  'hospitality.fulfillment.read alone does not book');
select pg_temp.as_platform();
select is((select count(*)::int from private.trash_tables where table_name = 'transfer_vehicles'), 1, 'vehicles are in Trash by label');
select is((select count(*)::int from private.trash_tables where table_name in ('transfers', 'transfer_passengers')), 0,
  'transfers and passengers are not');
select pg_temp.as_user('alice');
update app.transfers set driver_person_id = pg_temp.id('frank') where id = pg_temp.id('t3');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'transfer.driver_assigned' and subject_id = pg_temp.id('t3')), 1,
  'transfer.driver_assigned is emitted on a change of driver');

select * from finish();
rollback;
