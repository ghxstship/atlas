-- pgTAP: migration 1200, org legal entities (A52, ADR 0032 amendment). An Admin adds legal entities; the first is
-- primary and marking another moves the mark; the primary cannot be unmarked or deleted while others remain. The tax
-- identifier is Restricted and encrypted: written only through the RPC, never selectable, decrypted in the masked view
-- for the Owner (data.restricted.read.tax) and masked for the Admin. A Manager cannot read or write entities.
-- Cross-tenant and anon denied.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(24);

select has_table('app', 'org_legal_entities', 'app.org_legal_entities exists');

select pg_temp.as_user('bob');
select lives_ok($$insert into app.org_legal_entities (org_id, legal_name, country_code, fiscal_year_start_month, base_currency)
  values ((select id from world where key = 'org_a'), 'Northwind Live LLC', 'US', 1, 'USD')$$, 'an Admin adds a legal entity');
insert into world select 'le_us', id from app.org_legal_entities where legal_name = 'Northwind Live LLC';
select is((select is_primary from app.org_legal_entities where id = pg_temp.id('le_us')), true, 'the first legal entity is primary');
select lives_ok($$insert into app.org_legal_entities (org_id, legal_name, country_code, fiscal_year_start_month, base_currency)
  values ((select id from world where key = 'org_a'), 'Northwind Live Ltd', 'GB', 4, 'GBP')$$, 'an Admin adds a second entity in another country');
insert into world select 'le_gb', id from app.org_legal_entities where legal_name = 'Northwind Live Ltd';
select is((select is_primary from app.org_legal_entities where id = pg_temp.id('le_gb')), false, 'a later entity is not primary unless marked');
select throws_ok($$insert into app.org_legal_entities (org_id, legal_name, country_code, fiscal_year_start_month, base_currency)
  values ((select id from world where key = 'org_a'), ' northwind live llc ', 'US', 1, 'USD')$$,
  '23505', null, 'a legal name appears once per org, ignoring case and surrounding space');
select throws_ok($$insert into app.org_legal_entities (org_id, legal_name, country_code, fiscal_year_start_month, base_currency)
  values ((select id from world where key = 'org_a'), 'Northwind Live GmbH', 'DE', 13, 'EUR')$$,
  '23514', null, 'a fiscal year start month outside 1 to 12 is refused');
select throws_ok($$insert into app.org_legal_entities (org_id, legal_name, country_code, fiscal_year_start_month, base_currency)
  values ((select id from world where key = 'org_a'), 'Northwind Live GmbH', 'de', 1, 'EUR')$$,
  '23514', null, 'a country code must be two capital letters');

update app.org_legal_entities set is_primary = true where id = pg_temp.id('le_gb');
select is((select array_agg(legal_name order by legal_name) from app.org_legal_entities where is_primary and deleted_at is null),
  array['Northwind Live Ltd'], 'marking another entity primary moves the mark');
select throws_ok($$update app.org_legal_entities set is_primary = false where id = (select id from world where key = 'le_gb')$$,
  'XR001', 'legal_entity_primary: Mark another legal entity primary instead; the org keeps one primary entity.', 'the primary is never unmarked directly');
select throws_ok($$update app.org_legal_entities set deleted_at = now() where id = (select id from world where key = 'le_gb')$$,
  'XR001', 'legal_entity_primary: Mark another legal entity primary before deleting the primary one.', 'the primary cannot be deleted while another entity remains');

-- Tax identifier.
select throws_ok($$update app.org_legal_entities set tax_identifier_last4 = '6789' where id = (select id from world where key = 'le_us')$$,
  '42501', null, 'the tax identifier columns have no update grant');
select throws_ok($$select tax_identifier from app.org_legal_entities$$, '42501', null, 'the Restricted ciphertext is never selectable');
select lives_ok($$select app.set_org_legal_entity_tax_identifier((select id from world where key = 'le_us'), '12-3456789')$$,
  'an Admin sets the tax identifier through the RPC');
select is((select tax_identifier_last4 from app.org_legal_entities where id = pg_temp.id('le_us')), '6789', 'the last four are stored for display');
select throws_ok($$select app.set_org_legal_entity_tax_identifier((select id from world where key = 'le_us'), '12')$$,
  'XR001', null, 'a tax identifier shorter than four characters is refused');
select results_eq($$select tax_identifier, is_masked from app.org_legal_entities_masked where id = (select id from world where key = 'le_us')$$,
  $$values (null::text, true)$$, 'an Admin without data.restricted.read.tax sees the identifier masked');

select pg_temp.as_user('alice');
select is((select tax_identifier from app.org_legal_entities_masked where id = pg_temp.id('le_us')), '123456789',
  'the Owner reads the decrypted identifier');
select is((select count(*)::int from app.audit_events where action = 'org_legal_entities.tax_identifier_set' and diff::text like '%6789%'), 0,
  'the audit ledger records the change but never the value');

select pg_temp.as_user('carol');
select is((select count(*)::int from app.org_legal_entities), 0, 'a Manager reads no legal entities');
select throws_ok($$insert into app.org_legal_entities (org_id, legal_name, country_code, fiscal_year_start_month, base_currency)
  values ((select id from world where key = 'org_a'), 'Manager Entity', 'US', 1, 'USD')$$, '42501', null, 'a Manager cannot add one');
select throws_ok($$select app.set_org_legal_entity_tax_identifier((select id from world where key = 'le_us'), '987654321')$$,
  '42501', null, 'a Manager cannot set a tax identifier');

select pg_temp.as_user('xavier');
select is((select count(*)::int from app.org_legal_entities_masked), 0, 'cross-tenant: another org reads none');

select pg_temp.as_anon();
select throws_ok('select 1 from app.org_legal_entities', '42501', null, 'anon reads no legal entities');

select * from finish();
rollback;
