-- pgTAP: migration 2654 (R5), the project facts tables. Tables, live keys and checks (dates order, not empty, plate
-- format, shoe pair); every value column Confidential; AI exclusion, a 30-day retention row and the read-only exemption;
-- only the person selects their rows directly (the company Owner, an Advancing Lead and a producer with every capability
-- select none) and nobody inserts or updates directly; the access log carries fact_kinds; a save logs the changed column
-- names, never values.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql

select no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Shape ------------------------------------------------------------------------------------------------------------------
select has_table('app', t, 'app.' || t || ' exists') from unnest(array['roster_travel_requests', 'roster_uniform_sizes', 'roster_vehicles']) t;
select has_index('app', t, t || '_live_key', t || ' keeps one live row per entry')
from unnest(array['roster_travel_requests', 'roster_uniform_sizes', 'roster_vehicles']) t;
select has_type('app', 'project_fact_kind', 'app.project_fact_kind exists');
select has_type('app', 'shoe_size_system', 'app.shoe_size_system exists');
select has_column('app', 'work_detail_events', 'roster_entry_id', 'the access log names the roster entry (R4)');
select col_type_is('app', 'work_detail_events', 'fact_kinds', 'app.project_fact_kind[]', 'and the kinds an act covered');

select throws_ok(format($$insert into app.roster_travel_requests (roster_entry_id, inbound_on, outbound_on) values (%L, '2027-06-05', '2027-06-01')$$,
  pg_temp.id('e_kai')), '23514', null, 'the trip home never comes before the arrival');
select throws_ok(format($$insert into app.roster_travel_requests (roster_entry_id) values (%L)$$, pg_temp.id('e_kai')), '23514', null,
  'a travel request names an airport or a date');
select throws_ok(format($$insert into app.roster_vehicles (roster_entry_id, make, model, plate, plate_region) values (%L, 'Ford', 'Transit', 'ab-12', 'US-FL')$$,
  pg_temp.id('e_kai')), '23514', null, 'a plate is uppercase letters and digits');
select throws_ok(format($$insert into app.roster_vehicles (roster_entry_id, make, model, plate, plate_region) values (%L, 'Ford', 'Transit', 'AB12', 'Florida')$$,
  pg_temp.id('e_kai')), '23514', null, 'a plate region is an ISO 3166-2 code');
select throws_ok(format($$insert into app.roster_uniform_sizes (roster_entry_id, shoe_size) values (%L, 10.5)$$, pg_temp.id('e_kai')), '23514', null,
  'a shoe size carries its system');
select throws_ok(format($$insert into app.roster_uniform_sizes (roster_entry_id) values (%L)$$, pg_temp.id('e_kai')), '23514', null,
  'uniform sizes are never empty');

-- Classification, AI, retention, read-only, Trash --------------------------------------------------------------------------
select is((select count(*)::int from private.column_classifications
  where table_name in ('app.roster_travel_requests', 'app.roster_uniform_sizes', 'app.roster_vehicles') and classification = 'Confidential'),
  23, 'every value column of the three tables is Confidential');
select is((select count(*)::int from information_schema.columns c
  where c.table_schema = 'app' and c.table_name in ('roster_travel_requests', 'roster_uniform_sizes', 'roster_vehicles')
    and c.column_name not in ('id', 'org_id', 'roster_entry_id', 'deleted_at', 'created_at', 'created_by', 'updated_at', 'updated_by')
    and not exists (select 1 from private.column_classifications k
      where k.table_name = 'app.' || c.table_name and k.column_name = c.column_name and k.classification = 'Confidential')),
  0, 'no value column is left unclassified');
select is((select count(*)::int from private.ai_excluded_tables
  where table_name in ('app.roster_travel_requests', 'app.roster_uniform_sizes', 'app.roster_vehicles')), 3, 'no AI feature reads them');
select is((select count(*)::int from private.retention_policies
  where table_name in ('app.roster_travel_requests', 'app.roster_uniform_sizes', 'app.roster_vehicles') and retention = interval '30 days'),
  3, 'cleared rows leave after 30 days');
select is((select count(*)::int from private.read_only_exempt_tables
  where table_name in ('app.roster_travel_requests', 'app.roster_uniform_sizes', 'app.roster_vehicles')), 3,
  'the person clears their facts while the org is read-only');
select is((select count(*)::int from private.trash_excluded_tables
  where table_name in ('roster_travel_requests', 'roster_uniform_sizes', 'roster_vehicles')), 3, 'a cleared fact is not restored from Trash');

-- Reads and writes ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select lives_ok(format($$select app.save_roster_travel_request(%L, 'mia', 'MIA', '2027-06-01', '2027-06-04', 'Aisle', 'Vegetarian', true, true, null)$$,
  pg_temp.id('e_kai')), 'kai saves a travel request');
select lives_ok(format($$select app.save_roster_vehicle(%L, 'Ford', 'Transit', 'White', 'abc 12-34', 'us-fl')$$, pg_temp.id('e_kai')),
  'and a vehicle');
select pg_temp.as_platform();

select is(pg_temp.n('kai', 'select 1 from app.roster_travel_requests'), 1, 'the person selects their own travel request');
select is(pg_temp.n('kai', 'select 1 from app.roster_vehicles'), 1, 'and their vehicle');
select is(pg_temp.n('victor', 'select 1 from app.roster_travel_requests'), 0, 'the company Owner selects none directly');
select is(pg_temp.n('pia', 'select 1 from app.roster_travel_requests'), 0, 'nor does the Advancing Lead');
select is(pg_temp.n('alice', 'select 1 from app.roster_travel_requests union all select 1 from app.roster_vehicles'), 0,
  'nor a producer holding every capability');
select is(pg_temp.n('mo', 'select 1 from app.roster_travel_requests'), 0, 'nor another person on the roster');

select pg_temp.as_user('kai');
select throws_ok(format($$insert into app.roster_uniform_sizes (roster_entry_id, shirt_size) values (%L, 'M')$$, pg_temp.id('e_kai')),
  '42501', null, 'the person never inserts directly');
select throws_ok($$update app.roster_vehicles set color = 'Red'$$, '42501', null, 'nor updates directly');
select pg_temp.as_platform();

select is((select plate from app.roster_vehicles where roster_entry_id = pg_temp.id('e_kai')), 'ABC1234', 'the plate is normalized');
select is((select inbound_airport_code::text from app.roster_travel_requests where roster_entry_id = pg_temp.id('e_kai')), 'MIA',
  'and the airport code uppercased');

-- The access log ---------------------------------------------------------------------------------------------------------------
select is((select fact_kinds from app.work_detail_events where person_id = pg_temp.id('kai') and action = 'roster_travel_requests.insert'),
  array['Travel']::app.project_fact_kind[], 'a save logs its kind');
select is((select org_id from app.work_detail_events where person_id = pg_temp.id('kai') and action = 'roster_travel_requests.insert'),
  null, 'with no org when the person acted');
select ok((select changed_columns @> array['inbound_airport_code', 'needs_lodging'] from app.work_detail_events
  where person_id = pg_temp.id('kai') and action = 'roster_travel_requests.insert'), 'and the names of the columns given');
select is((select count(*)::int from app.work_detail_events
  where person_id = pg_temp.id('kai') and action like 'roster_%' and changed_columns::text ilike '%MIA%'), 0, 'never a value');

select pg_temp.as_user('kai');
select lives_ok(format($$select app.save_roster_travel_request(%L, 'MIA', 'JFK', '2027-06-01', '2027-06-04', 'Aisle', 'Vegetarian', true, true, null)$$,
  pg_temp.id('e_kai')), 'kai changes the airport home');
select pg_temp.as_platform();
select is((select changed_columns from app.work_detail_events where person_id = pg_temp.id('kai') and action = 'roster_travel_requests.update'),
  array['outbound_airport_code'], 'an update logs only the column that changed');

select pg_temp.as_user('kai');
select app.clear_roster_project_fact(pg_temp.id('e_kai'), 'Vehicle');
select pg_temp.as_platform();
select is(pg_temp.events('kai', 'roster_vehicles.delete'), 1, 'a clear logs as a delete');
select is(pg_temp.n('kai', 'select 1 from app.roster_vehicles where deleted_at is null'), 0, 'and leaves no live row');

select * from finish();
rollback;
