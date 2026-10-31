-- pgTAP: migration 2320, postal codes checked by country (A139, S15-13). The patterns match whole and ignoring case;
-- a country without one takes 1 to 12 characters. Venues (country from the jurisdiction), org legal entities and
-- vendors refuse a new or changed postal code that does not fit; a stored row that does not change is never refused.
-- Vendor address fields need a country. The legal entity address reads through the masked view.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(24);

-- Patterns ---------------------------------------------------------------------------------------------------------
select ok(private.postal_code_fits('US', '33132') and private.postal_code_fits('US', '33132-1234') and private.postal_code_fits('US', '33132 1234'),
  'a US ZIP and ZIP+4 fit');
select ok(not private.postal_code_fits('US', '3313') and not private.postal_code_fits('US', '33132-12'), 'a short ZIP does not fit');
select ok(private.postal_code_fits('CA', 'k1a 0b1') and private.postal_code_fits('CA', 'K1A0B1'), 'a Canadian code fits in either case and spacing');
select ok(private.postal_code_fits('GB', 'SW1A 1AA') and private.postal_code_fits('GB', 'GIR 0AA') and not private.postal_code_fits('GB', 'SW1A 1CI'),
  'British codes follow the outward and inward form');
select ok(private.postal_code_fits('NL', '1012 AB') and private.postal_code_fits('JP', '100-0001') and private.postal_code_fits('IE', 'D02 X285'),
  'Dutch, Japanese and Irish codes fit');
select ok(not private.postal_code_fits('DE', '1234') and private.postal_code_fits('DE', '10115'), 'a German code has five digits');
select ok(private.postal_code_fits('ZZ', 'ANY 123') and not private.postal_code_fits('ZZ', '1234567890123'),
  'a country without a pattern takes 1 to 12 characters');
select ok(private.postal_code_fits('US', null), 'a missing postal code fits');
select is(private.postal_code_pattern('us'), private.postal_code_pattern('US'), 'the country code is read in either case');

-- Venues -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select lives_ok($$update app.venues set street_address = '301 Bayfront Walk', locality = 'Miami', postal_code = '33132'
  where id = pg_temp.id('venue_a')$$, 'a venue takes a postal code that fits its country');
select throws_ok($$update app.venues set postal_code = 'SW1A 1AA' where id = pg_temp.id('venue_a')$$,
  'XR001', null, 'a venue refuses a postal code that does not fit the country of its jurisdiction');
select throws_ok($$insert into app.venues (org_id, name, jurisdiction_id, time_zone, postal_code)
  values (pg_temp.id('org_a'), 'Quay Stage', 'US-FL-MIAMI-DADE', 'America/New_York', '3313')$$,
  'XR001', null, 'a new venue with a short ZIP is refused');

-- A row stored before the check keeps working until its postal code or country changes.
select pg_temp.as_platform();
alter table app.venues disable trigger t45_venue_postal_code;
update app.venues set postal_code = 'MIAMI' where id = pg_temp.id('venue_a');
alter table app.venues enable trigger t45_venue_postal_code;
select pg_temp.as_user('alice');
select lives_ok($$update app.venues set name = 'Northwind Pier Pavilion East' where id = pg_temp.id('venue_a')$$,
  'a stored venue whose postal code does not fit can still be renamed');
select throws_ok($$update app.venues set postal_code = 'MIAMI 2' where id = pg_temp.id('venue_a')$$,
  'XR001', null, 'changing that postal code is checked');
select pg_temp.as_platform();
select is((select stored_value from private.contact_format_exceptions where row_id = pg_temp.id('venue_a')), 'MIAMI',
  'the stored postal code that does not fit is listed');

-- Org legal entities -------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into app.org_legal_entities (org_id, legal_name, country_code, fiscal_year_start_month, base_currency)
values (pg_temp.id('org_a'), 'Northwind Live Ltd', 'GB', 4, 'GBP');
insert into world select 'le_gb', id from app.org_legal_entities where legal_name = 'Northwind Live Ltd';
select lives_ok($$update app.org_legal_entities set street_address = '10 Downing Street', locality = 'London', postal_code = 'SW1A 2AA'
  where id = pg_temp.id('le_gb')$$, 'an Admin records a registered address in the entity''s country');
select throws_ok($$update app.org_legal_entities set postal_code = '33132' where id = pg_temp.id('le_gb')$$,
  'XR001', null, 'a legal entity refuses a postal code from another country');
select throws_ok($$update app.org_legal_entities set country_code = 'US' where id = pg_temp.id('le_gb')$$,
  'XR001', null, 'moving the entity to a country its postal code does not fit is refused');
select is((select concat_ws(' | ', street_address, locality, postal_code) from app.org_legal_entities_masked where id = pg_temp.id('le_gb')),
  '10 Downing Street | London | SW1A 2AA', 'the masked view reads the registered address');
select pg_temp.as_user('carol');
update app.org_legal_entities set locality = 'Leeds' where id = pg_temp.id('le_gb');
select pg_temp.as_platform();
select is((select locality from app.org_legal_entities where id = pg_temp.id('le_gb')), 'London', 'a Manager cannot change the registered address');

-- Vendors ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world values ('cp_v', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v')) returning id)
  insert into world select 'ven', id from x;
select lives_ok($$update app.vendors set country_code = 'CA', street_address = '1 Front Street W', locality = 'Toronto',
  administrative_area = 'ON', postal_code = 'M5J 2X5' where id = pg_temp.id('ven')$$, 'a vendor takes a mailing address in its country');
select throws_ok($$update app.vendors set postal_code = '33132' where id = pg_temp.id('ven')$$,
  'XR001', null, 'a vendor refuses a postal code that does not fit its country');
select throws_ok($$update app.vendors set country_code = null where id = pg_temp.id('ven')$$,
  '23514', null, 'a vendor address needs its country');
select pg_temp.as_platform();
select is((select count(*)::integer from private.contact_format_exceptions where table_name in ('app.org_legal_entities', 'app.vendors')), 0,
  'addresses saved through the checks are never listed');
