-- pgTAP: migration 1611, ruling D13 as owner decision 39 (2026-10-23, RRR-66) reads it. A line posts to the priced
-- item's explicit GL default, else its class's account, else its counterparty type's default: in the lookup itself,
-- in budget line amounts, and in what approving an expense and posting an invoice write to the journal.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(22);

select is(private.gl_account_for_line('0000.51.01', 'Expense', '0000.51.01-XOS-004'), '1500',
  'a balance-sheet item posts to its own account, which no class derives');
select is(private.gl_account_for_line('0000.51.01', 'Expense', '0000.51.01-XOS-006'), '5000',
  'an item whose explicit account is its class''s posts as before');
select is(private.gl_account_for_line('5000.01.01', 'Expense'), private.gl_account_for('5000.01.01', 'Expense'),
  'a line with no item posts by class');
select is(private.gl_account_for_line('0000.51.01', 'Revenue', '0000.51.01-XOS-004'), '4000',
  'an item with no explicit account of the type falls back to its class');

-- A receivable under a class with no revenue account takes the counterparty type's default.
create temporary table sponsor as
select c.id from app.counterparties c where c.deleted_at is null order by c.id limit 1;
update app.counterparties set counterparty_type = 'Sponsor' where id = (select id from sponsor);
select is(private.gl_account_for('6000.01.01', 'Revenue'), null, 'Operations has no revenue account of its own');
select is(private.gl_account_for_line('6000.01.01', 'Revenue', null, (select id from sponsor)), '4300',
  'a Sponsor''s revenue posts to the Sponsor type''s default account');
select is(private.gl_account_for_line('6000.01.01', 'Expense', null, (select id from sponsor)), '5600',
  'the class account comes before the counterparty type''s default');
select is(private.gl_account_for('8000.01.01', 'Revenue'), '4800', 'Hospitality has a revenue account of its own');
select is(private.gl_account_for_line('8000.01.01', 'Revenue', null, (select id from sponsor)), '4800',
  'a Sponsor''s revenue under a class with a revenue account posts to the class account, not the Sponsor default');

-- Budget line amounts report the account the line will post to.
create temporary table line as
select bl.id from app.budget_lines bl where bl.deleted_at is null order by bl.id limit 1;
update app.budget_lines set urid = '0000.51.01', element_id = '0000.51.01-XOS-005', xyz_basis = 'Declared'
where id = (select id from line);
select is((select account_code from app.budget_line_amounts where budget_line_id = (select id from line)), '1500',
  'a budget line pricing a deposit reports the deposit''s asset account');
update app.budget_lines set element_id = null where id = (select id from line);
select is((select account_code from app.budget_line_amounts where budget_line_id = (select id from line)), '5000',
  'without the item the line reports its class account');

-- Approving an expense and posting an invoice use the same lookup ---------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.accounting_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-01', '2027-06-30') returning id) insert into world select 'per_jun', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Deposits', 'USD') returning id) insert into world select 'bud_d', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, element_id, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_d'), 1, 'Pier Rigging Co deposit.', '0000.51.01', '0000.51.01-XOS-005', 1, 50000, 'X', 'Declared') returning id) insert into world select 'line_dep', id from x;
with x as (insert into app.change_orders (project_id, budget_id, title) values (pg_temp.id('prj_a'), pg_temp.id('bud_d'), 'Larger deposit') returning id) insert into world select 'co_dep', id from x;
insert into app.change_order_lines (change_order_id, budget_line_id, description, urid, unit_price_minor)
  values (pg_temp.id('co_dep'), pg_temp.id('line_dep'), 'Deposit increase.', '0000.51.01', 5000);
with x as (insert into app.change_orders (project_id, budget_id, title) values (pg_temp.id('prj_a'), pg_temp.id('bud_d'), 'Rigging labor') returning id) insert into world select 'co_mix', id from x;
insert into app.change_order_lines (change_order_id, budget_line_id, description, urid, unit_price_minor)
  values (pg_temp.id('co_mix'), pg_temp.id('line_dep'), 'Rigging labor instead of deposit.', '5000.01.01', 2000);
-- A budget line pricing an ordinary Production item, whose explicit account is its class's (5500).
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, element_id, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_d'), 2, 'Line array rental.', '5000.01.01', '5000.01.01-XOS-001', 1, 80000, 'X', 'Declared') returning id) insert into world select 'line_ord', id from x;
insert into world values ('cp_vendor', app.create_counterparty(pg_temp.id('org_a'), 'Pier Rigging Co', 'Rigging Engineering'));
insert into world values ('cp_sponsor', app.create_counterparty(pg_temp.id('org_a'), 'Lakeshore Brands', null));
with x as (insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, counterparty_id)
  values (pg_temp.id('line_dep'), 'Rigging deposit.', '2027-06-10', 40000, 'USD', pg_temp.id('cp_vendor')) returning id) insert into world select 'exp_dep', id from x;
with x as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code, issued_on)
  values (pg_temp.id('prj_a'), 'Payable', pg_temp.id('cp_vendor'), 'PRC-7001', 'USD', '2027-06-12') returning id) insert into world select 'inv_dep', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, unit_price_minor, budget_line_id)
  values (pg_temp.id('inv_dep'), 1, 'Second rigging deposit.', 10000, pg_temp.id('line_dep'));
-- Lines that name a URID other than their budget line's bill something else: the budget line's item does not price them.
with x as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code, issued_on)
  values (pg_temp.id('prj_a'), 'Payable', pg_temp.id('cp_vendor'), 'PRC-7002', 'USD', '2027-06-13') returning id) insert into world select 'inv_mix', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, unit_price_minor, budget_line_id, urid) values
  (pg_temp.id('inv_mix'), 1, 'Rigging labor billed against the deposit line.', 7000, pg_temp.id('line_dep'), '5000.01.01'),
  (pg_temp.id('inv_mix'), 2, 'Site crew billed against the line array line.', 3000, pg_temp.id('line_ord'), '6000.01.01');
with x as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code, issued_on)
  values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_sponsor'), 'NWL-SP-101', 'USD', '2027-06-14') returning id) insert into world select 'inv_sp', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, unit_price_minor, urid)
  values (pg_temp.id('inv_sp'), 1, 'Activation crew.', 30000, '6000.01.01');
select pg_temp.as_user('bob');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values
  (pg_temp.id('org_a'), pg_temp.system_role('owner'), 'Expense', 'USD', 10000000),
  (pg_temp.id('org_a'), pg_temp.system_role('owner'), 'Invoice Approval', 'USD', 10000000);
select pg_temp.as_platform();
update app.counterparties set counterparty_type = 'Sponsor' where id = pg_temp.id('cp_sponsor');

select is((select account_code from app.change_order_line_facts where change_order_id = pg_temp.id('co_dep')), '1500',
  'a change to the deposit line reports the deposit''s account');
select is((select account_code from app.change_order_line_facts where change_order_id = pg_temp.id('co_mix')), '5500',
  'a change naming another URID on the deposit line reports that URID''s class account');

select pg_temp.as_user('alice');
select is(app.approve_expense(pg_temp.id('exp_dep'), 'Deposit paid.'), true, 'the expense on the deposit line is approved');
select is(app.approve_invoice(pg_temp.id('inv_dep'), 'Deposit invoiced.'), true, 'the payable on the deposit line is approved');
select is(app.approve_invoice(pg_temp.id('inv_mix'), 'Crew invoiced.'), true, 'the payable naming other URIDs is approved');
select pg_temp.as_user('carol');
select lives_ok($$select app.issue_invoice((select id from world where key = 'inv_sp'), 'Sent to the sponsor.')$$,
  'a receivable to a Sponsor under a class with no revenue account is issued, where it used to be refused');
select pg_temp.as_platform();
select is((select amount_minor from app.posting_lines where external_ref = pg_temp.id('exp_dep') and account_code = '1500'), 40000::bigint,
  'approving the expense debits the deposit''s asset account, which no class derives');
select is((select amount_minor from app.posting_lines where external_ref = pg_temp.id('inv_dep') and account_code = '1500'), 10000::bigint,
  'a payable line on the deposit''s budget line debits the same account');
select is(
  (select string_agg(account_code || '=' || amount_minor, ', ' order by account_code) from app.posting_lines
    where external_ref = pg_temp.id('inv_mix') and amount_minor > 0),
  '5500=7000, 5600=3000',
  'a payable line naming 5000.01.01 on the deposit line debits 5500, not 1500, and one naming 6000.01.01 on a line pricing a 5500 item debits 5600');
select is((select amount_minor from app.posting_lines where external_ref = pg_temp.id('inv_sp') and account_code = '4300'), -30000::bigint,
  'the Sponsor''s revenue is credited to the Sponsor type''s default account');
select is((select amount_minor from app.posting_lines where external_ref = pg_temp.id('inv_sp') and account_code = '1100'), 30000::bigint,
  'and Accounts Receivable is debited');

select * from finish();
rollback;
