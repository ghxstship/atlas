-- pgTAP: migration 1611, ruling D13 as owner decision 39 (2026-10-23, RRR-66) reads it. A line posts to the priced
-- item's explicit GL default, else its class's account, else its counterparty type's default.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(9);

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

select * from finish();
rollback;
