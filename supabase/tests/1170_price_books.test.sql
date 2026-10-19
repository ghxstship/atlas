-- pgTAP: migration 1170, org price books (A50, ADR 0032). A Manager maintains price books, a Member reads them and
-- cannot write, a name appears once per org among live books, the currency must be a known ISO 4217 code, delete is
-- soft and frees the name. Cross-tenant deny and anon deny.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(13);

select has_table('app', 'price_books', 'app.price_books exists');

select pg_temp.as_user('carol');
select lives_ok($$insert into app.price_books (org_id, name, currency_code) values ((select id from world where key = 'org_a'), 'Standard Client Rates', 'USD')$$,
  'a Manager creates a price book');
select is((select created_by from app.price_books where name = 'Standard Client Rates'), pg_temp.id('carol'), 'the audit columns name the creator');
select throws_ok($$insert into app.price_books (org_id, name, currency_code) values ((select id from world where key = 'org_a'), '  standard client rates ', 'EUR')$$,
  '23505', null, 'a name appears once per org, ignoring case and surrounding space');
select throws_ok($$insert into app.price_books (org_id, name, currency_code) values ((select id from world where key = 'org_a'), 'Euro Rates', 'XXQ')$$,
  '23503', null, 'an unknown currency is refused');
select throws_ok($$insert into app.price_books (org_id, name, currency_code) values ((select id from world where key = 'org_a'), '   ', 'USD')$$,
  '23514', null, 'a blank name is refused');
select lives_ok($$update app.price_books set deleted_at = now() where name = 'Standard Client Rates'$$, 'a Manager deletes a price book');
select lives_ok($$insert into app.price_books (org_id, name, currency_code) values ((select id from world where key = 'org_a'), 'Standard Client Rates', 'GBP')$$,
  'a deleted book frees its name');

select pg_temp.as_user('dave');
select is((select count(*)::int from app.price_books where deleted_at is null), 1, 'a Member reads the price books');
select throws_ok($$insert into app.price_books (org_id, name, currency_code) values ((select id from world where key = 'org_a'), 'Member Rates', 'USD')$$,
  '42501', null, 'a Member cannot create a price book');

select pg_temp.as_user('xavier');
select is((select count(*)::int from app.price_books), 0, 'cross-tenant: another org reads none');
select throws_ok($$insert into app.price_books (org_id, name, currency_code) values ((select id from world where key = 'org_a'), 'Cross', 'USD')$$,
  '42501', null, 'cross-tenant: another org cannot create one');

select pg_temp.as_anon();
select throws_ok('select 1 from app.price_books', '42501', null, 'anon reads no price books');

select * from finish();
rollback;
