-- pgTAP: migration 0765, invoices for external accounts (Section 4.4.5, Section 8.7). Access through the account
-- (Owner, Admin, Finance), denial for a supplied person, another account and another tenant, receivables only once
-- issued, status dates and NULL-aware totals, the money area time box, and party submission with its refusals.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Fixture: the Client account Coral Group on prj_a ------------------------------------------------------------------------------
select pg_temp.new_user('cleo', 'cleo@coral-group.test', 'Cleo Marsh');
select pg_temp.as_user('cleo');
insert into world values ('acct_c', app.create_external_account('Coral Group', 'coral-group'));
select pg_temp.as_user('alice');
insert into world values ('cp_c_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_c')));
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
    arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cleo'), pg_temp.id('cp_c_a'), 'Client', '5000.51.02', 'INDEPENDENT_CONTRACTOR',
    'Day Rate', 'Per Engagement', '2027-06-01') returning id) insert into world select 'eng_client_a', id from e;
select pg_temp.as_platform();

-- Party submission ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select throws_ok(format($$select app.submit_engagement_invoice('%s', 'BA-1001', '2027-06-05', '2027-07-05', 'USD',
  '[{"description": "Audio crew day", "quantity": 2, "unit_price_minor": 120000}]')$$, pg_temp.id('eng_vendor_a')),
  '42501', null, 'Onboarding: the money area is closed, so no invoice yet');
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_client_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');

select pg_temp.as_user('victor');
select throws_ok(format($$select app.submit_engagement_invoice('%s', ' ', null, null, 'USD', '[{"description": "Day"}]')$$, pg_temp.id('eng_vendor_a')),
  'XR001', null, 'an invoice carries the party''s own number');
select throws_ok(format($$select app.submit_engagement_invoice('%s', 'BA-1000', null, null, 'USD', '[]')$$, pg_temp.id('eng_vendor_a')),
  'XR001', null, 'an invoice needs a line');
with i as (select app.submit_engagement_invoice(pg_temp.id('eng_vendor_a'), 'BA-1001', '2027-06-05', '2027-07-05', 'USD',
  '[{"description": "Audio crew day", "quantity": 2, "unit_price_minor": 120000}, {"description": "Console rental"}]'::jsonb) as id)
  insert into world select 'inv_v', id from i;
select pg_temp.as_platform();
select is((select invoice_state::text from app.invoices where id = pg_temp.id('inv_v')), 'Proposed', 'a submitted invoice arrives Proposed');
select is((select direction::text from app.invoices where id = pg_temp.id('inv_v')), 'Payable', 'as a payable of the org');
select pg_temp.as_user('sam');
select throws_ok(format($$select app.submit_engagement_invoice('%s', 'BA-1002', null, null, 'USD', '[{"description": "Day"}]')$$, pg_temp.id('eng_vendor_a')),
  '42501', null, 'a supplied person cannot invoice for the account');
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.submit_engagement_invoice('%s', 'IM-1', null, null, 'USD', '[{"description": "Day"}]')$$, pg_temp.id('eng_ivy_a')),
  'XR001', null, 'an individual without an account is told to add one');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.submit_engagement_invoice('%s', 'Q-1', null, null, 'USD', '[{"description": "Day"}]')$$, pg_temp.id('eng_vendor_a')),
  '42501', null, 'denial: another party cannot invoice on this engagement');
select pg_temp.as_platform();

-- Reading payables -----------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('victor', 'select 1 from api_external.invoices'), 1, 'account: the Owner reads the account''s invoice');
select is(pg_temp.n('fiona', 'select 1 from api_external.invoices'), 1, 'account: Account Finance reads it');
select is(pg_temp.n('sam', 'select 1 from api_external.invoices'), 0, 'denial: the supplied person never reads the account''s invoices');
select is(pg_temp.n('cleo', $$select 1 from api_external.invoices where direction = 'Payable'$$), 0, 'denial: another account');
select is(pg_temp.n('xavier', 'select 1 from api_external.invoices'), 0, 'denial: another tenant''s member');
select pg_temp.as_user('fiona');
select is((select total_minor from api_external.invoices), null::bigint, 'an unpriced line leaves the total blank');
select is((select balance_minor from api_external.invoices), null::bigint, 'and the balance');
select is((select count(*)::int from api_external.invoice_lines), 2, 'the account reads the lines');
select is((select amount_minor from api_external.invoice_lines where line_number = 1), 240000::bigint, 'line amounts are derived');
select pg_temp.as_platform();
select hasnt_column('api_external', 'invoice_lines', 'budget_line_id', 'budget lines never reach externals');

-- Receivables: visible once issued, with status dates ---------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.accounting_periods (org_id, starts_on, ends_on)
  values ((select org_id from app.projects where id = pg_temp.id('prj_a')), date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date);
select pg_temp.as_user('alice');
with i as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code, due_on)
  values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_c_a'), 'NWL-0001', 'USD', '2027-08-01') returning id)
  insert into world select 'inv_c', id from i;
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor, urid) values (pg_temp.id('inv_c'), 1, 'Production fee', 1, 5000000, '0000.01.01');
select pg_temp.as_platform();
select is(pg_temp.n('cleo', 'select 1 from api_external.invoices'), 0, 'a receivable draft stays internal');
select pg_temp.as_user('alice');
select app.issue_invoice(pg_temp.id('inv_c'), 'Billing the production fee.');
select pg_temp.as_platform();
select is(pg_temp.n('cleo', 'select 1 from api_external.invoices'), 1, 'own engagement: the client reads the issued invoice');
select pg_temp.as_user('cleo');
select ok((select issued_at is not null and approved_at is null from api_external.invoices), 'the issue date comes from the ledger');
select is((select total_minor from api_external.invoices), 5000000::bigint, 'a priced invoice has its total');
select is((select balance_minor from api_external.invoices), 5000000::bigint, 'and the full balance until paid');
select pg_temp.as_platform();

-- The money area closes 18 months after Complete -------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select is(pg_temp.n('fiona', 'select 1 from api_external.invoices'), 1, 'Complete: the money area stays open');
select pg_temp.backdate_close('eng_vendor_a', interval '19 months');
select is(pg_temp.n('fiona', 'select 1 from api_external.invoices'), 0, 'after 18 months the account''s invoices close');
select pg_temp.as_anon();
select throws_ok('select 1 from api_external.invoices', '42501', null, 'anon deny');
select pg_temp.as_platform();

select * from finish();
rollback;
