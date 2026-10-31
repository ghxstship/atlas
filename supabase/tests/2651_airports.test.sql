-- pgTAP: migrations 2651 and 2652 (R5), the airports of a travel request. The table, its checks and indexes; the seed
-- holds more than 1,000 active airports, among them those the journeys and tests name; anon reads nothing, a signed-in
-- person reads the active rows, nobody writes.
-- The two checks of more than 1,000 airports are TODO until the owner step lands: the committed airports.csv is a
-- 177-airport starter set until `pnpm --filter @xos/schemas fetch:airports` replaces it with the OurAirports snapshot
-- (see packages/schemas/airports/airports.csv). pg_prove reports them as not ok # TODO without failing the suite; drop
-- the todo_start and todo_end lines with the snapshot, and they gate as written.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select no_plan();

select has_table('app', 'airports', 'app.airports exists');
select col_is_pk('app', 'airports', 'iata_code', 'keyed by IATA code');
select has_index('app', 'airports', 'airports_name_lower_idx', 'names are searched case-insensitively');
select has_index('app', 'airports', 'airports_country_code_idx', 'and by country');
select todo_start('owner step: the OurAirports snapshot replaces the 177-airport starter set');
select ok((select count(*) from app.airports where is_active) > 1000, 'the seed holds more than 1,000 active airports');
select todo_end();
select is((select array_agg(iata_code::text order by iata_code) from app.airports where iata_code in ('MIA', 'JFK', 'LHR')),
  array['JFK', 'LHR', 'MIA'], 'MIA, JFK and LHR exist');
select is((select name from app.airports where iata_code = 'MIA'), 'Miami International Airport', 'with their names');
select throws_ok($$insert into app.airports (iata_code, name, country_code) values ('ab1', 'Bad', 'US')$$, '23514', null,
  'a code is three capital letters');
select throws_ok($$insert into app.airports (iata_code, name, country_code) values ('ZZZ', 'Bad', 'USA')$$, null, null,
  'a country is two capital letters');

select pg_temp.as_anon();
select throws_ok($$select count(*) from app.airports$$, '42501', null, 'anon cannot read airports');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.airports where iata_code in ('MIA', 'JFK', 'LHR')), 3, 'a signed-in person reads them');
select todo_start('owner step: the OurAirports snapshot replaces the 177-airport starter set');
select ok((select count(*) from app.airports) > 1000, 'all of the more than 1,000');
select todo_end();
select throws_ok($$insert into app.airports (iata_code, name, country_code) values ('ZZY', 'Nowhere', 'US')$$, '42501', null,
  'and cannot add one');
select throws_ok($$update app.airports set name = 'Renamed' where iata_code = 'MIA'$$, '42501', null, 'nor rename one');
select pg_temp.as_platform();
update app.airports set is_active = false where iata_code = 'LGB';
select pg_temp.as_user('dave');
select is((select count(*)::int from app.airports where iata_code = 'LGB'), 0, 'an inactive airport is not offered');
select pg_temp.as_platform();

select * from finish();
rollback;
