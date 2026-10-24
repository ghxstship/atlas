-- pgTAP: migration 1613, a member reads the account a budget or change order line posts to (RRR-133). The views that
-- report it, app.budget_line_amounts and app.change_order_line_facts, read as the member, and the lookup they call no
-- longer names schema private, which members may not use; the accounts are those 1611 decides.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(4);

select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Deposits', 'USD') returning id) insert into world select 'bud_d', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, element_id, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_d'), 1, 'Pier Rigging Co deposit.', '0000.51.01', '0000.51.01-XOS-005', 1, 50000, 'X', 'Declared') returning id) insert into world select 'line_dep', id from x;
with x as (insert into app.change_orders (project_id, budget_id, title) values (pg_temp.id('prj_a'), pg_temp.id('bud_d'), 'Rigging labor') returning id) insert into world select 'co_mix', id from x;
insert into app.change_order_lines (change_order_id, budget_line_id, description, urid, unit_price_minor)
  values (pg_temp.id('co_mix'), pg_temp.id('line_dep'), 'Rigging labor instead of deposit.', '5000.01.01', 2000);

select lives_ok($$select account_code from app.budget_line_amounts$$, 'a member reads budget line amounts');
select is((select account_code from app.budget_line_amounts where budget_line_id = pg_temp.id('line_dep')), '1500',
  'and a line pricing a deposit reports the deposit''s own account');
select lives_ok($$select account_code from app.change_order_line_facts$$, 'a member reads change order line facts');
select is((select account_code from app.change_order_line_facts where change_order_id = pg_temp.id('co_mix')), '5500',
  'and a change naming another URID on the deposit line reports that URID''s class account');

select * from finish();
rollback;
