-- pgTAP: live occupancy with 80, 90 and 100 percent alerts, weather thresholds and alerts, guest check-in at doors
-- and the lost and found log (A29, Section 4.9 production-specific additions).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(41);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

select pg_temp.as_user('alice');
with s as (insert into app.spaces (venue_id, name, area_sq_ft) values (pg_temp.id('venue_a'), 'Main Floor', 500) returning id) insert into k select 'floor', id from s;
with s as (insert into app.spaces (venue_id, name, capacity) values (pg_temp.id('venue_a'), 'VIP Deck', 10) returning id) insert into k select 'deck', id from s;

-- Occupancy -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select throws_ok($$select app.create_occupancy_counter(pg_temp.id('prj_a'), 'Main Floor', (select id from k where key = 'floor'), 'Assembly - standing space')$$,
  '42501', null, 'a field member cannot configure counters');
select pg_temp.as_user('carol');
select lives_ok($$insert into k select 'counter', app.create_occupancy_counter(pg_temp.id('prj_a'), 'Main Floor', (select id from k where key = 'floor'), 'Assembly - standing space')$$,
  'a manager sizes a counter from the Bible occupant load factor');
select is((select permitted_load || ' ' || load_basis::text from app.occupancy_counters where id = (select id from k where key = 'counter')),
  '100 Occupant Load Factor', '500 sq ft at 5 sq ft per person permits 100');
select lives_ok($$insert into k select 'deck_counter', app.create_occupancy_counter(pg_temp.id('prj_a'), 'VIP Deck', (select id from k where key = 'deck'))$$,
  'a counter sized from the space capacity');
select throws_ok($$select app.create_occupancy_counter(pg_temp.id('prj_a'), 'Bad factor', (select id from k where key = 'floor'), 'Exits required')$$, 'XR001', null,
  'only occupant load factors size a counter');
select throws_ok($$select app.create_occupancy_counter(pg_temp.id('prj_a'), 'No basis', (select id from k where key = 'floor'))$$, 'XR001', null,
  'a counter needs a permit load, a factor or a space capacity');

select pg_temp.as_user('frank');
select is(app.record_occupancy_count((select id from k where key = 'counter'), 79, 'Gate A'), 79, 'door staff count people in');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications where kind = 'occupancy.threshold'), 0, 'no alert below 80 percent');
select pg_temp.as_user('frank');
select app.record_occupancy_count((select id from k where key = 'counter'), 1, 'Gate A');
select pg_temp.as_platform();
select ok((select count(*) > 0 from app.notifications where kind = 'occupancy.threshold' and message_args ->> 'percent' = '80'), 'crossing 80 percent alerts the dispatchers');
select pg_temp.as_user('frank');
select app.record_occupancy_count((select id from k where key = 'counter'), 20, 'Gate B');
select is((select alert_level_percent from app.occupancy_counters where id = (select id from k where key = 'counter')), 100::smallint, 'the count reaches 100 percent');
select app.record_occupancy_count((select id from k where key = 'counter'), -30, 'Gate B');
select is((select alert_level_percent from app.occupancy_counters where id = (select id from k where key = 'counter')), 0::smallint, 'dropping below 80 resets the level');
select throws_ok($$select app.record_occupancy_count((select id from k where key = 'counter'), -500)$$, 'XR001', null, 'the count never goes below zero');
select throws_ok($$update app.occupancy_counters set current_count = 5 where id = (select id from k where key = 'counter')$$, '42501', null,
  'the count changes only through door counts');
select pg_temp.as_user('gina');
select throws_ok($$select app.record_occupancy_count((select id from k where key = 'counter'), 1)$$, '42501', null, 'a viewer cannot count');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.occupancy_counters where org_id = pg_temp.id('org_a')), 0, 'no cross-tenant counter reads');
select pg_temp.as_anon();
select throws_ok($$select count(*) from app.occupancy_counters$$, '42501', null, 'anon reads no counters');

-- Weather ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.weather_thresholds (org_id, project_id, hazard, alert_level, threshold_value, unit, comparison, source_note) values
  (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Wind', 'Monitor', 20, 'mph', 'At or Above', 'Emergency plan 4.2'),
  (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Wind', 'Restrict', 30, 'mph', 'At or Above', 'Emergency plan 4.2'),
  (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Wind', 'Evacuate', 40, 'mph', 'At or Above', 'Emergency plan 4.2'),
  (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Lightning', 'Evacuate', 8, 'mi', 'At or Below', 'Emergency plan 4.3');
select throws_ok($$insert into app.weather_thresholds (org_id, project_id, hazard, alert_level, threshold_value, unit, comparison, source_note)
  values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Wind', 'Monitor', 25, 'mph', 'At or Above', 'Twice')$$, '23505', null, 'one threshold per hazard and level');
select throws_ok($$insert into app.weather_thresholds (org_id, project_id, hazard, alert_level, threshold_value, unit, comparison, source_note)
  values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Heat', 'Monitor', 90, 'mph', 'At or Above', 'Wrong unit')$$, '23514', null, 'each hazard has its unit');
insert into app.role_assignments (project_id, role_code, person_id) values (pg_temp.id('prj_a'), (select role_code from xpms.dim_role order by role_code limit 1), pg_temp.id('erin'));
insert into app.weather_alert_roles (org_id, project_id, alert_level, role_code) values
  (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Evacuate', (select role_code from xpms.dim_role order by role_code limit 1));

select pg_temp.as_user('frank');
select lives_ok($$select app.record_weather_reading(pg_temp.id('prj_a'), 'Wind', 12)$$, 'a calm reading is recorded');
select is((select count(*)::integer from app.weather_alerts where project_id = pg_temp.id('prj_a')), 0, 'no alert below every level');
select app.record_weather_reading(pg_temp.id('prj_a'), 'Wind', 33);
select is((select alert_level::text from app.weather_alerts where project_id = pg_temp.id('prj_a') and cleared_at is null), 'Restrict', 'a gust of 33 mph raises Restrict');
select app.record_weather_reading(pg_temp.id('prj_a'), 'Wind', 45);
select is((select alert_level::text from app.weather_alerts where project_id = pg_temp.id('prj_a') and cleared_at is null), 'Evacuate', 'a stronger gust escalates to Evacuate');
select pg_temp.as_platform();
select ok((select count(*) > 0 from app.notifications n where n.kind = 'weather.alert' and n.recipient_person_id = pg_temp.id('erin') and n.message_args ->> 'level' = 'Evacuate'),
  'the role the emergency plan names for Evacuate is alerted');
select pg_temp.as_user('frank');
select app.record_weather_reading(pg_temp.id('prj_a'), 'Lightning', 6);
select is((select count(*)::integer from app.weather_alerts where project_id = pg_temp.id('prj_a') and cleared_at is null), 2, 'lightning within 8 miles raises its own alert');
select app.record_weather_reading(pg_temp.id('prj_a'), 'Wind', 10);
select is((select count(*)::integer from app.weather_alerts where project_id = pg_temp.id('prj_a') and hazard = 'Wind' and cleared_at is null), 0, 'a calm reading clears the wind alert');
select throws_ok($$update app.weather_readings set reading_value = 1$$, '42501', null, 'readings are append-only');

-- Guest check-in ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with g as (insert into app.guest_list_entries (project_id, guest_name, plus_ones, entry_state) values (pg_temp.id('prj_a'), 'Jordan Ellis', 2, 'Approved') returning id)
insert into k select 'guest', id from g;
with g as (insert into app.guest_list_entries (project_id, guest_name, plus_ones) values (pg_temp.id('prj_a'), 'Sam Ortiz', 0) returning id)
insert into k select 'pending', id from g;
select pg_temp.as_user('frank');
select is((select count(*)::integer from app.door_guest_list(pg_temp.id('prj_a'), 'jordan')), 1, 'door staff search the approved list');
select throws_ok($$select app.check_in_guest((select id from k where key = 'guest'), 3::smallint, 'Gate A')$$, 'XR001', null, 'plus-ones never exceed the list');
select throws_ok($$select app.check_in_guest((select id from k where key = 'pending'))$$, 'XR001', null, 'only approved guests are checked in');
select throws_ok($$select app.check_in_guest((select id from k where key = 'guest'), 0::smallint, 'Gate A', 'NO-SUCH-BADGE')$$, 'XR001', null,
  'a scanned credential must be valid for the project');
select lives_ok($$insert into k select 'checkin', app.check_in_guest((select id from k where key = 'guest'), 2::smallint, 'Gate A')$$, 'door staff check in a guest with plus-ones');
select is((select entry_state::text from app.guest_list_entries where id = (select id from k where key = 'guest')), 'Checked In', 'the guest list shows the check-in');
select throws_ok($$select app.check_in_guest((select id from k where key = 'guest'))$$, 'XR001', null, 'a guest is checked in once');

-- Lost and found -------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select lives_ok($$insert into k select 'item', app.log_lost_item(pg_temp.id('prj_a'), 'Wallet', 'Brown leather wallet, no cash.', 'Bar 2', 'Security office locker 4')$$,
  'a field member logs a found item');
select is((select item_number from app.lost_found_items where id = (select id from k where key = 'item')), 'LF-0001', 'items are numbered per org');
select lives_ok($$insert into k select 'claim', app.claim_lost_item((select id from k where key = 'item'), 'Riley Park', '+1 305 555 0142', 'Knew the library card name inside.')$$,
  'a claim is recorded');
select throws_ok($$select app.claim_lost_item((select id from k where key = 'item'), 'Second Person', 'second@example.test', 'Also mine.')$$, 'XR001', null,
  'one open claim per item');
select throws_ok($$select app.settle_lost_item_claim((select id from k where key = 'claim'), true)$$, '42501', null, 'field staff cannot settle claims');
select pg_temp.as_user('carol');
select lives_ok($$select app.settle_lost_item_claim((select id from k where key = 'claim'), true, 'ID matched.')$$, 'a manager returns the item');
select is((select item_state::text from app.lost_found_items where id = (select id from k where key = 'item')), 'Returned', 'the item is returned');

select pg_temp.as_platform();
select is((select count(*)::integer from app.domain_events where org_id = pg_temp.id('org_a') and event_type in
  ('occupancy.threshold_reached', 'weather_alert.raised', 'weather_alert.cleared', 'guest.checked_in_at_door', 'lost_item.logged', 'lost_item.claimed', 'lost_item.returned')), 10,
  'site operations emit their domain events: 2 occupancy crossings (80, then straight to 100), 3 weather alerts, 1 clear, 1 door check-in, 1 log, 1 claim, 1 return');

select * from finish();
rollback;
