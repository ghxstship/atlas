-- pgTAP: migration 2940 (B5, G-58), the flight grid. Three Flight legs within 24 hours form one journey with the last
-- leg's arrival as final arrival, a leg two days later starts another, and a Ground segment is a journey of one. Phases
-- follow the clock (fixed times relative to now()). Only hospitality.fulfillment.read holders read rows; the fare never
-- appears; a roster traveller is named through private.known_person_name (and app.person_names); xos_backup cannot
-- select the view.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 2940_travel_world.psql

select no_plan();

create function pg_temp.grid(p_who text) returns setof app.travel_grid
language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  return query select * from app.travel_grid g where g.project_id = pg_temp.id('prj_a');
  perform pg_temp.as_platform();
end $$;

create function pg_temp.leg(p_who text, p_key text) returns app.travel_grid
language sql as $$ select g from pg_temp.grid(p_who) g where g.id = pg_temp.id(p_key) $$;

-- Kai flies three legs around now and one more two days later; mo has a ground transfer segment.
select pg_temp.flight('f1', 'kai', 'NW101', 'LHR', now() - interval '6 hours', 'JFK', now() - interval '3 hours');
select pg_temp.flight('f2', 'kai', 'NW202', 'JFK', now() - interval '1 hour', 'ATL', now() + interval '1 hour');
select pg_temp.flight('f3', 'kai', 'NW303', 'ATL', now() + interval '3 hours', 'MIA', now() + interval '5 hours');
select pg_temp.flight('f4', 'kai', 'NW404', 'MIA', now() + interval '2 days', 'LHR', now() + interval '2 days 9 hours');
select pg_temp.flight('f5', 'mo', 'NW505', 'LHR', now() - interval '2 hours', 'MIA', null);
select pg_temp.as_user('alice');
with x as (insert into app.travel_segments (project_id, person_id, travel_mode, departs_from, departs_at, departs_time_zone,
  arrives_at_place, arrives_at, arrives_time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('mo'), 'Ground', 'MIA', now() + interval '1 day', 'America/New_York', 'Crew Hotel',
    now() + interval '1 day 1 hour', 'America/New_York') returning id)
insert into world select 'g1', id from x;
select pg_temp.as_platform();

-- Journeys -------------------------------------------------------------------------------------------------------------------
select is((select array_agg(g.leg_number order by g.departs_at) from pg_temp.grid('hops') g where g.person_id = pg_temp.id('kai')),
  array[1, 2, 3, 1], 'three legs within 24 hours are legs 1 to 3, and the leg two days later starts a journey');
select is((select array_agg(distinct g.leg_count) from pg_temp.grid('hops') g where g.journey_id = pg_temp.id('f1')), array[3],
  'the first journey has three legs');
select is((select count(*)::int from pg_temp.grid('hops') g where g.journey_id = pg_temp.id('f1')
  and g.final_arrival_place = 'MIA' and g.final_arrival_at = (select arrives_at from app.travel_segments where id = pg_temp.id('f3'))),
  3, 'every leg carries the last leg''s arrival');
select is((pg_temp.leg('hops', 'f4')).journey_id, pg_temp.id('f4'), 'the later leg is its own journey');
select is((pg_temp.leg('hops', 'f4')).leg_count, 1, 'of one leg');
select is(((pg_temp.leg('hops', 'g1')).leg_number, (pg_temp.leg('hops', 'g1')).leg_count, (pg_temp.leg('hops', 'g1')).journey_id),
  (1, 1, pg_temp.id('g1')), 'a Ground segment is a journey of one leg');

-- Phases ------------------------------------------------------------------------------------------------------------------
select is((pg_temp.leg('hops', 'f1')).phase, 'Landed', 'an arrival in the past has landed');
select is((pg_temp.leg('hops', 'f2')).phase, 'In Flight', 'a departed leg with a future arrival is in flight');
select is((pg_temp.leg('hops', 'f3')).phase, 'Upcoming', 'a future departure is upcoming');
select is((pg_temp.leg('hops', 'f5')).phase, 'Departed', 'a departed leg with no arrival time has departed');
select is((select count(*)::int from pg_temp.grid('hops') g where g.phase = 'Upcoming' and g.travel_mode = 'Flight'), 2,
  'the Upcoming view lists departures after now');

-- Names and readers ---------------------------------------------------------------------------------------------------------
select is((pg_temp.leg('hops', 'f1')).traveler_name, 'Kai Morgan', 'a roster traveller is named for the org''s desk');
select pg_temp.as_user('hops');
select is((select full_name from app.person_names(array[pg_temp.id('kai')])), 'Kai Morgan', 'and through app.person_names');
select is((select count(*)::int from app.people where id = pg_temp.id('kai')), 0, 'while app.people itself stays closed to the desk');
select pg_temp.as_platform();
select is((select count(*)::int from pg_temp.grid('creds')), 0, 'a reader without hospitality.fulfillment.read sees no rows');
select is((select count(*)::int from pg_temp.grid('quinn')), 0, 'nor does someone outside the org');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'app' and table_name = 'travel_grid'
  and column_name in ('price_minor', 'currency_code')), 'the fare never appears');
select ok(not has_table_privilege('xos_backup', 'app.travel_grid', 'select'), 'xos_backup cannot select the grid');
select ok(not has_table_privilege('anon', 'app.travel_grid', 'select'), 'nor can anon');

-- A withdrawn roster entry is no longer known by name through the roster.
select pg_temp.as_user('mia');
select is((select count(*)::int from app.person_names(array[pg_temp.id('kai')])), 1, 'any member of the org knows kai by name');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.person_names(array[pg_temp.id('kai')])), 0, 'another org does not');
select pg_temp.as_platform();

select * from finish();
rollback;
