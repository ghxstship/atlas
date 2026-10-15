-- pgTAP: app.invoice_match_results access (migration 0491). Signed-in readers with finance.invoice.read
-- on the project read variances; project outsiders and other tenants read none; anon is refused;
-- platform reads keep working; the private variance functions stay closed to authenticated.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(9);

select pg_temp.as_user('alice');
insert into world values ('cp', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor)
  values (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Purchase Order', 'USD', 1000000);
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp')) returning id) insert into world select 'ven', id from x;
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po', id from x;
with x as (insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor)
  values (pg_temp.id('po'), 1, 'Stage deck sections.', 2, 20000) returning id) insert into world select 'pol', id from x;
select pg_temp.as_user('bob');
select app.approve_purchase_order(pg_temp.id('po'), 'Within limit.');
select pg_temp.as_user('carol');
with x as (insert into app.goods_receipts (purchase_order_id) values (pg_temp.id('po')) returning id) insert into world select 'gr', id from x;
insert into app.receipt_lines (goods_receipt_id, po_line_id, quantity_received) values (pg_temp.id('gr'), pg_temp.id('pol'), 2);
with x as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code)
  values (pg_temp.id('prj_a'), 'Payable', pg_temp.id('cp'), 'HS-1001', 'USD') returning id) insert into world select 'inv', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor) values (pg_temp.id('inv'), 1, 'Stage deck sections.', 2, 21000);
with x as (insert into app.invoice_matches (invoice_id, purchase_order_id, goods_receipt_id) values (pg_temp.id('inv'), pg_temp.id('po'), pg_temp.id('gr')) returning id)
  insert into world select 'match', id from x;

select lives_ok('select * from app.invoice_match_results', 'a signed-in reader reads match results');
select is((select variance_minor from app.invoice_match_results where invoice_match_id = pg_temp.id('match')), 2000::bigint, 'a Manager reads the derived variance');
select is((select is_matched from app.invoice_match_results where invoice_match_id = pg_temp.id('match')), false, 'and sees the mismatch');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.invoice_match_results), 0, 'a Viewer outside the project reads none');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.invoice_match_results), 0, 'another org reads none');
select throws_ok($$select private.invoice_match_variance((select id from world where key = 'match'))$$, '42501', null, 'the variance function stays closed to authenticated');
select pg_temp.as_anon();
select throws_ok('select 1 from app.invoice_match_results', '42501', null, 'anon cannot read match results');
select pg_temp.as_platform();
select is((select count(*)::int from app.invoice_match_results where invoice_match_id = pg_temp.id('match')), 1, 'platform reads keep working');
select is((select variance_minor from app.invoice_match_results where invoice_match_id = pg_temp.id('match')), 2000::bigint, 'with the same variance');

select * from finish();
rollback;
