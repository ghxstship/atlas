-- pgTAP: accounting connectors (Section 17). Account mappings (RLS, role bands, category guard), the UPL ledger
-- export queue and the payment queue (exported rows leave the queue), and idempotent intake of provider payments
-- that land Proposed for a person to approve.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

-- World: a connected Xero, a calendar connection, a posted journal and an approved payment -----------------------------
select pg_temp.as_user('bob');
with c as (insert into app.integration_connections (org_id, provider_code, display_name, external_account_id)
  values (pg_temp.id('org_a'), 'xero', 'Northwind Xero', 'tenant-nwl') returning id) insert into world select 'xero', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name)
  values (pg_temp.id('org_a'), 'google_calendar', 'Northwind Calendar') returning id) insert into world select 'gcal', id from c;
select app.store_integration_credential(pg_temp.id('xero'), 'fixture-token', 'OAuth Token');
select app.transition_integration_connection(pg_temp.id('xero'), 'Pending', 'Connected', 'Authorized.');

select pg_temp.as_user('carol');
with x as (insert into app.accounting_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-07-01', '2027-07-31') returning id) insert into world select 'per', id from x;
with x as (insert into app.journal_entries (accounting_period_id, entry_date, memo) values (pg_temp.id('per'), '2027-07-02', 'Accrue stage storage.') returning id) insert into world select 'je1', id from x;
insert into app.journal_lines (journal_entry_id, line_number, account_code, description, debit_minor, currency_code) values (pg_temp.id('je1'), 1, '5000', 'Storage accrual.', 5000, 'USD');
insert into app.journal_lines (journal_entry_id, line_number, account_code, description, credit_minor, currency_code) values (pg_temp.id('je1'), 2, '2100', 'Storage accrual.', 5000, 'USD');
with x as (insert into app.journal_entries (accounting_period_id, entry_date, memo) values (pg_temp.id('per'), '2027-07-03', 'Unposted draft.') returning id) insert into world select 'je2', id from x;
insert into app.journal_lines (journal_entry_id, line_number, account_code, description, debit_minor, currency_code) values (pg_temp.id('je2'), 1, '5000', 'Draft.', 100, 'USD');
insert into world values ('cp_vendor', app.create_counterparty(pg_temp.id('org_a'), 'Pier Rigging Co', 'Rigging Engineering'));
with x as (insert into app.payments (counterparty_id, direction, amount_minor, currency_code, paid_on) values (pg_temp.id('cp_vendor'), 'Payable', 1000, 'USD', '2027-07-06') returning id) insert into world select 'pay1', id from x;
select pg_temp.as_user('alice');
select app.post_journal_entry(pg_temp.id('je1'), 'Reviewed.');
select app.approve_payment(pg_temp.id('pay1'), 'Pay.');

-- Account mappings --------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok($$insert into app.integration_account_mappings (integration_connection_id, account_code, external_account_id) values ((select id from world where key = 'xero'), '5000', '400')$$,
  'an Admin maps a GL account to a Xero account');
select throws_ok($$insert into app.integration_account_mappings (integration_connection_id, account_code, external_account_id) values ((select id from world where key = 'xero'), '5000', '401')$$,
  '23505', null, 'one mapping per account and connection');
select throws_ok($$insert into app.integration_account_mappings (integration_connection_id, account_code, external_account_id) values ((select id from world where key = 'xero'), '9999', '401')$$,
  '23503', null, 'only accounts of the fixed chart map');
select throws_ok($$insert into app.integration_account_mappings (integration_connection_id, account_code, external_account_id) values ((select id from world where key = 'gcal'), '2100', '800')$$,
  'XR001', 'integration_category_mismatch: integration_account_mappings rows belong to a Accounting connection, not a Calendar connection.', 'mappings belong to accounting connections');
select is((select org_id from app.integration_account_mappings limit 1), pg_temp.id('org_a'), 'the org comes from the connection');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.integration_account_mappings), 0, 'a Manager reads no mappings');
select throws_ok($$insert into app.integration_account_mappings (integration_connection_id, account_code, external_account_id) values ((select id from world where key = 'xero'), '2100', '800')$$,
  '42501', null, 'a Manager cannot map accounts');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.integration_account_mappings), 0, 'another org reads no mappings');
select pg_temp.as_anon();
select throws_ok('select 1 from app.integration_account_mappings', '42501', null, 'anon cannot read mappings');
select throws_ok('select 1 from app.integration_ledger_queue', '42501', null, 'anon cannot read the ledger queue');
select throws_ok('select 1 from app.integration_payment_queue', '42501', null, 'anon cannot read the payment queue');

-- Ledger queue ---------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select count(*)::int from app.integration_ledger_queue where integration_connection_id = pg_temp.id('xero')), 2, 'both lines of the posted entry wait for export');
select is((select count(*)::int from app.integration_ledger_queue where journal_entry_id = pg_temp.id('je2')), 0, 'an unposted entry never queues');
select is((select sum(amount_minor)::bigint from app.integration_ledger_queue where journal_entry_id = pg_temp.id('je1')), 0::bigint, 'queued lines balance');
select is((select minor_unit_exponent::int from app.integration_ledger_queue limit 1), 2, 'the currency exponent comes with the line');
select is((select count(*)::int from app.integration_ledger_queue where integration_connection_id = pg_temp.id('gcal')), 0, 'only accounting connections queue lines');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.integration_ledger_queue), 2, 'the Owner reads the queue (finance and integrations access)');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.integration_ledger_queue), 0, 'another org reads none of it');
select pg_temp.as_platform();
select app.upsert_integration_external_id(pg_temp.id('xero'), 'Journal Entry', pg_temp.id('je1'), 'MJ-0001');
select is((select count(*)::int from app.integration_ledger_queue where integration_connection_id = pg_temp.id('xero')), 0, 'an exported entry leaves the queue');
select pg_temp.as_user('bob');
select app.transition_integration_connection(pg_temp.id('xero'), 'Connected', 'Paused', 'Close.');
select pg_temp.as_platform();
delete from app.integration_external_ids where external_id = 'MJ-0001';
select is((select count(*)::int from app.integration_ledger_queue), 0, 'a paused connection queues nothing');
select pg_temp.as_user('bob');
select app.transition_integration_connection(pg_temp.id('xero'), 'Paused', 'Connected', 'Open.');

-- Payment queue -------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select count(*)::int from app.integration_payment_queue where payment_id = pg_temp.id('pay1')), 1, 'an approved payment waits for the connection');
select is((select counterparty_external_id from app.integration_payment_queue where payment_id = pg_temp.id('pay1')), null, 'its counterparty is not mapped yet');
select app.upsert_integration_external_id(pg_temp.id('xero'), 'Counterparty', pg_temp.id('cp_vendor'), 'contact-77');
select is((select counterparty_external_id from app.integration_payment_queue where payment_id = pg_temp.id('pay1')), 'contact-77', 'the provider contact appears once mapped');
select app.upsert_integration_external_id(pg_temp.id('xero'), 'Payment', pg_temp.id('pay1'), 'payment-501');
select is((select count(*)::int from app.integration_payment_queue), 0, 'a pushed payment leaves the queue');

-- Provider payments in -------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$select app.record_provider_payment((select id from world where key = 'xero'), 'payment-900', 'contact-77', 'Payable', 2500, 'USD', '2027-07-09')$$,
  '42501', null, 'signed-in callers cannot record provider payments');
select pg_temp.as_platform();
select lives_ok($$insert into world values ('pay_in', app.record_provider_payment((select id from world where key = 'xero'), 'payment-900', 'contact-77', 'Payable', 2500, 'USD', '2027-07-09', 'ACH 4411'))$$,
  'the runner records a provider payment');
select is((select payment_state::text from app.payments where id = pg_temp.id('pay_in')), 'Proposed', 'it lands Proposed for a person to approve');
select is((select counterparty_id from app.payments where id = pg_temp.id('pay_in')), pg_temp.id('cp_vendor'), 'for the mapped counterparty');
select is((select created_by from app.payments where id = pg_temp.id('pay_in')), null::uuid, 'recorded by the platform, not a person');
select is(app.record_provider_payment(pg_temp.id('xero'), 'payment-900', 'contact-77', 'Payable', 2500, 'USD', '2027-07-09'), pg_temp.id('pay_in'),
  'the same provider payment is recorded once');
select throws_ok($$select app.record_provider_payment((select id from world where key = 'xero'), 'payment-901', 'contact-unknown', 'Payable', 10, 'USD', '2027-07-09')$$,
  'XR001', 'counterparty_unmapped: Provider contact contact-unknown is not mapped to a counterparty.', 'an unmapped provider contact is refused');
select throws_ok($$select app.record_provider_payment((select id from world where key = 'gcal'), 'payment-902', 'contact-77', 'Payable', 10, 'USD', '2027-07-09')$$,
  'XR001', 'integration_category_mismatch: Provider payments arrive only through an accounting connection.', 'only accounting connections bring payments');
select throws_ok($$select app.record_provider_payment((select id from world where key = 'xero'), 'payment-903', 'contact-77', 'Payable', 0, 'USD', '2027-07-09')$$,
  '23514', null, 'the payment checks still apply');

select * from finish();
rollback;
