-- pgTAP: 3013, purchase order payment instalments (B12, RRR-236, gap G-195). Unique numbers per order, nothing on a
-- Canceled order, on a Closed order only a bill linked to, or the removal of, an unbilled instalment (restores refused),
-- a Canceled bill read as no bill everywhere, the live instalments within the order's known total of lines, approved
-- change orders, tax and shipping, a billed instalment's amount fixed, one instalment per bill and only a live,
-- non-Canceled payable of the order's vendor, project and currency, and app.po_instalment_schedule's statuses from
-- Approved payments (paid) and Proposed ones (scheduled), stopping at Invoiced without finance.payment.read, with the
-- schedule's and the order's totals, refused without procurement.po.read.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql
\ir 3010_payables_world.psql

select no_plan();


create function pg_temp.make_order(p_key text, p_price bigint, p_tax bigint, p_shipping bigint) returns void
language plpgsql as $$
declare
  v uuid;
begin
  insert into app.purchase_orders (project_id, vendor_id, currency_code, tax_minor, shipping_minor)
  values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD', p_tax, p_shipping) returning id into v;
  insert into world values (p_key, v);
  insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor)
  values (v, 1, 'Rigging package.', 2, p_price);
end $$;


-- World: vendors, an approved order of 1,000.00 of lines plus 50.00 tax and 20.00 shipping -------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_rig')) returning id) insert into world select 'ven', id from x;
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_lake')) returning id) insert into world select 'ven_lake', id from x;
select pg_temp.make_order('po_a', 50000, 5000, 2000);
select pg_temp.make_order('po_c', 10000, null, null);
select pg_temp.make_order('po_x', 10000, null, null);
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po_u', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, quantity) values (pg_temp.id('po_u'), 1, 'Price to follow.', 1);
select pg_temp.as_user('bob');
select app.approve_purchase_order(pg_temp.id(k), 'Within limit.') from unnest(array['po_a', 'po_c', 'po_x']) k;
select pg_temp.as_platform();
select is((select tax_minor + shipping_minor from app.purchase_orders where id = pg_temp.id('po_a')), 7000::bigint,
  'po_a: 1,000.00 of lines and 70.00 of tax and shipping (1,070.00)');

-- Catalog ---------------------------------------------------------------------------------------------------------------------
select has_table('app', 'po_payment_instalments', 'purchase orders have a payment schedule');
select is((select title_column from private.trash_tables where table_name = 'po_payment_instalments'), 'label',
  'removed instalments go to Trash under their label');
select ok(exists (select 1 from private.retention_policies where table_name = 'app.po_payment_instalments'),
  'instalments carry the default retention');

-- Scheduling ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok(format($$insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor)
  values (%L, 1, 'Deposit', '2027-06-01', 50000)$$, pg_temp.id('po_a')), 'a 500.00 deposit is scheduled');
insert into world select 'i_dep', i.id from app.po_payment_instalments i where i.purchase_order_id = pg_temp.id('po_a') and i.instalment_number = 1;
select throws_ok(format($$insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor)
  values (%L, 1, 'Deposit again', '2027-06-01', 100)$$, pg_temp.id('po_a')), '23505', null, 'instalment numbers are unique per order');
select throws_like(format($$insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor)
  values (%L, 2, 'Balance', '2027-07-01', 57001)$$, pg_temp.id('po_a')),
  'po_instalments_exceed_order:%', 'the schedule never exceeds lines, tax and shipping (po_instalments_exceed_order)');
select lives_ok(format($$insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor)
  values (%L, 2, 'Balance', '2027-07-01', 57000)$$, pg_temp.id('po_a')), 'a balance up to the gross total is scheduled');
insert into world select 'i_bal', i.id from app.po_payment_instalments i where i.purchase_order_id = pg_temp.id('po_a') and i.instalment_number = 2;
with x as (insert into app.po_change_orders (purchase_order_id, description, amount_delta_minor) values (pg_temp.id('po_a'), 'Extra truss.', 3000) returning id)
  insert into world select 'pco', id from x;
select pg_temp.move('po_change_order', 'app.po_change_orders', 'po_change_order_id', 'pco', 'Proposed', 'Approved');
select pg_temp.as_user('carol');
select lives_ok(format($$update app.po_payment_instalments set amount_minor = 60000 where id = %L$$, pg_temp.id('i_bal')),
  'an approved change order raises what the schedule may reach');
select throws_like(format($$update app.po_payment_instalments set amount_minor = 60001 where id = %L$$, pg_temp.id('i_bal')),
  'po_instalments_exceed_order:%', 'but not beyond it');
select throws_ok(format($$update app.po_payment_instalments set purchase_order_id = %L where id = %L$$, pg_temp.id('po_c'), pg_temp.id('i_bal')),
  'XR001', 'po_instalment_immutable: An instalment stays on its purchase order.', 'an instalment stays on its order (po_instalment_immutable)');
select lives_ok(format($$insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor)
  values (%L, 1, 'Deposit', '2027-06-01', 999999)$$, pg_temp.id('po_u')), 'an order with an unpriced line has no known total, so the check waits');

-- Linking bills ---------------------------------------------------------------------------------------------------------------
select pg_temp.bill('bill_dep', 'cp_rig', 'USD', 50000, '2027-06-05');
select pg_temp.bill('bill_lake', 'cp_lake', 'USD', 60000, '2027-07-05');
select pg_temp.bill('bill_void', 'cp_rig', 'USD', 60000, '2027-07-05');
select pg_temp.move('invoice', 'app.invoices', 'invoice_id', 'bill_void', 'Approved', 'Disputed');
select pg_temp.move('invoice', 'app.invoices', 'invoice_id', 'bill_void', 'Disputed', 'Canceled');

select pg_temp.as_user('carol');
select lives_ok(format($$update app.po_payment_instalments set invoice_id = %L where id = %L$$, pg_temp.id('bill_dep'), pg_temp.id('i_dep')),
  'the vendor''s deposit bill is linked');
select throws_ok(format($$update app.po_payment_instalments set invoice_id = %L where id = %L$$, pg_temp.id('bill_dep'), pg_temp.id('i_bal')),
  '23505', null, 'a bill bills one instalment');
select throws_ok(format($$update app.po_payment_instalments set invoice_id = %L where id = %L$$, pg_temp.id('bill_lake'), pg_temp.id('i_bal')),
  'XR001', 'po_instalment_invoice: Link a live payable bill from the order''s vendor, on its project and in its currency, that is not matched to another order.',
  'another vendor''s bill is refused (po_instalment_invoice)');
select throws_ok(format($$update app.po_payment_instalments set invoice_id = %L where id = %L$$, pg_temp.id('bill_void'), pg_temp.id('i_bal')),
  'XR001', 'po_instalment_invoice: Link a live payable bill from the order''s vendor, on its project and in its currency, that is not matched to another order.',
  'a Canceled bill is refused');
select throws_ok(format($$update app.po_payment_instalments set amount_minor = 40000 where id = %L$$, pg_temp.id('i_dep')),
  'XR001', 'po_instalment_invoiced: A billed instalment keeps its amount; unlink the bill first.',
  'a billed instalment keeps its amount (po_instalment_invoiced)');
select lives_ok(format($$update app.po_payment_instalments set label = 'Deposit (50%%)', due_on = '2027-06-02' where id = %L$$, pg_temp.id('i_dep')),
  'its label and date still change');

-- The schedule ----------------------------------------------------------------------------------------------------------------
select is((select string_agg(label || ':' || status, ',' order by instalment_number) from app.po_instalment_schedule(pg_temp.id('po_a'))),
  'Deposit (50%):Invoiced,Balance:Scheduled', 'a billed instalment is Invoiced, an unbilled one Scheduled');
select is((select invoice_number || '/' || invoice_total_minor from app.po_instalment_schedule(pg_temp.id('po_a')) where instalment_number = 1),
  'BILL_DEP/50000', 'the bill''s number and total including tax are shown to a finance reader');

-- A Proposed payment is scheduled; an Approved one is paid.
select pg_temp.as_platform();
with x as (insert into app.payments (counterparty_id, direction, amount_minor, currency_code, paid_on)
  values (pg_temp.id('cp_rig'), 'Payable', 20000, 'USD', '2027-06-03') returning id) insert into world select 'pay_1', id from x;
insert into app.payment_applications (payment_id, invoice_id, amount_minor) values (pg_temp.id('pay_1'), pg_temp.id('bill_dep'), 20000);
select pg_temp.as_user('carol');
select is((select status || '/' || paid_minor || '/' || scheduled_minor from app.po_instalment_schedule(pg_temp.id('po_a')) where instalment_number = 1),
  'Invoiced/0/20000', 'a Proposed payment counts as scheduled, not paid');
select pg_temp.move('payment', 'app.payments', 'payment_id', 'pay_1', 'Proposed', 'Approved');
select pg_temp.as_user('carol');
select is((select status || '/' || paid_minor || '/' || scheduled_minor from app.po_instalment_schedule(pg_temp.id('po_a')) where instalment_number = 1),
  'Part paid/20000/0', 'an Approved payment counts as paid');
select pg_temp.as_platform();
with x as (insert into app.payments (counterparty_id, direction, amount_minor, currency_code, paid_on)
  values (pg_temp.id('cp_rig'), 'Payable', 30000, 'USD', '2027-06-04') returning id) insert into world select 'pay_2', id from x;
insert into app.payment_applications (payment_id, invoice_id, amount_minor) values (pg_temp.id('pay_2'), pg_temp.id('bill_dep'), 30000);
select pg_temp.move('payment', 'app.payments', 'payment_id', 'pay_2', 'Proposed', 'Approved');
select pg_temp.as_user('carol');
select is((select status from app.po_instalment_schedule(pg_temp.id('po_a')) where instalment_number = 1), 'Paid',
  'Paid once Approved payments reach the bill''s total');
select is((select (is_invoice_withheld or is_payment_withheld)::text from app.po_instalment_schedule(pg_temp.id('po_a')) where instalment_number = 1),
  'false', 'nothing is withheld from a reader with the finance reads');
select is((select distinct schedule_total_minor || '/' || order_total_minor from app.po_instalment_schedule(pg_temp.id('po_a'))),
  '110000/110000', 'the schedule''s total and the order''s total with its change order, tax and shipping');
select is((select distinct coalesce(order_total_minor::text, 'null') from app.po_instalment_schedule(pg_temp.id('po_u'))), 'null',
  'the order''s total is NULL while a line is unpriced');

-- Without finance.payment.read the status stops at Invoiced: Paid would read out the payment.
select pg_temp.as_platform();
delete from app.role_capabilities where role_id = pg_temp.system_role('member') and capability_code = 'finance.payment.read';
select pg_temp.as_user('dave');
select is((select status || '/' || coalesce(paid_minor::text, 'null') || '/' || is_payment_withheld::text || '/' || (invoice_id is not null)::text
  from app.po_instalment_schedule(pg_temp.id('po_a')) where instalment_number = 1), 'Invoiced/null/true/true',
  'a procurement reader without finance.payment.read sees Invoiced, no paid amount, and the bill''s id');
select pg_temp.as_platform();
insert into app.role_capabilities (role_id, capability_code, reach) values (pg_temp.system_role('member'), 'finance.payment.read', 'organization');
select pg_temp.as_user('carol');
select pg_temp.as_user('gina');
select throws_ok(format($$select * from app.po_instalment_schedule(%L)$$, pg_temp.id('po_a')), '42501', null,
  'the schedule needs procurement.po.read on the project');
select pg_temp.as_user('xavier');
select throws_ok(format($$select * from app.po_instalment_schedule(%L)$$, pg_temp.id('po_a')), '42501', null, 'and another org reads none of it');
select pg_temp.as_platform();

-- Closed and Canceled orders --------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok(format($$insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor)
  values (%L, 1, 'Deposit', '2027-06-01', 5000)$$, pg_temp.id('po_c')), 'po_c has a deposit');
insert into world select 'i_c1', i.id from app.po_payment_instalments i where i.purchase_order_id = pg_temp.id('po_c') and i.instalment_number = 1;
select lives_ok(format($$insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor)
  values (%L, 2, 'Balance', '2027-07-01', 5000)$$, pg_temp.id('po_c')), 'and a balance');
insert into world select 'i_c2', i.id from app.po_payment_instalments i where i.purchase_order_id = pg_temp.id('po_c') and i.instalment_number = 2;
select lives_ok(format($$insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor)
  values (%L, 3, 'Holdback', '2027-08-01', 1000)$$, pg_temp.id('po_c')), 'and a holdback');
insert into world select 'i_c3', i.id from app.po_payment_instalments i where i.purchase_order_id = pg_temp.id('po_c') and i.instalment_number = 3;
update app.po_payment_instalments set deleted_at = now() where id = pg_temp.id('i_c3');
select pg_temp.bill('bill_gone', 'cp_rig', 'USD', 5000, '2027-06-06');
select pg_temp.as_user('carol');
update app.po_payment_instalments set invoice_id = pg_temp.id('bill_gone') where id = pg_temp.id('i_c1');
select app.transition_purchase_order(pg_temp.id('po_c'), 'Approved', 'Sent', 'Emailed.');
select app.transition_purchase_order(pg_temp.id('po_c'), 'Sent', 'Closed', 'Delivered.');
select throws_ok(format($$insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor)
  values (%L, 4, 'Extra', '2027-07-01', 500)$$, pg_temp.id('po_c')),
  'XR001', 'po_instalment_order_state: A Closed order only links a bill to an unbilled instalment or removes an unbilled instalment.',
  'a Closed order takes no new instalment (po_instalment_order_state)');
select throws_ok(format($$update app.po_payment_instalments set deleted_at = null where id = %L$$, pg_temp.id('i_c3')),
  'XR001', 'po_instalment_order_state: A Closed order only links a bill to an unbilled instalment or removes an unbilled instalment.',
  'restores none from Trash');
select throws_ok(format($$update app.po_payment_instalments set amount_minor = 4000 where id = %L$$, pg_temp.id('i_c2')),
  'XR001', 'po_instalment_order_state: A Closed order only links a bill to an unbilled instalment or removes an unbilled instalment.',
  'changes no amount');
select throws_ok(format($$update app.po_payment_instalments set deleted_at = now() where id = %L$$, pg_temp.id('i_c1')),
  'XR001', 'po_instalment_order_state: A Closed order only links a bill to an unbilled instalment or removes an unbilled instalment.',
  'and removes no billed instalment');
select pg_temp.bill('bill_late', 'cp_rig', 'USD', 5000, '2027-07-05');
select pg_temp.as_user('carol');
select lives_ok(format($$update app.po_payment_instalments set invoice_id = %L where id = %L$$, pg_temp.id('bill_late'), pg_temp.id('i_c2')),
  'a bill arriving after close links to an unbilled instalment');
select throws_ok(format($$update app.po_payment_instalments set invoice_id = %L, label = 'Changed' where id = %L$$, pg_temp.id('bill_lake'), pg_temp.id('i_c3')),
  'XR001', 'po_instalment_order_state: A Closed order only links a bill to an unbilled instalment or removes an unbilled instalment.',
  'nothing else changes with the link');

-- A Canceled bill is no bill: the schedule says Scheduled, a Closed order lets it be replaced, and its amount is free again.
select pg_temp.move('invoice', 'app.invoices', 'invoice_id', 'bill_gone', 'Approved', 'Disputed');
select pg_temp.move('invoice', 'app.invoices', 'invoice_id', 'bill_gone', 'Disputed', 'Canceled');
select pg_temp.as_user('carol');
select is((select status || '/' || coalesce(invoice_id::text, 'null') || '/' || coalesce(invoice_number, 'null') from app.po_instalment_schedule(pg_temp.id('po_c')) where instalment_number = 1),
  'Scheduled/null/null', 'an instalment whose bill is Canceled is Scheduled, with no bill columns');
select pg_temp.bill('bill_new', 'cp_rig', 'USD', 5000, '2027-06-07');
select pg_temp.as_user('carol');
select lives_ok(format($$update app.po_payment_instalments set invoice_id = %L where id = %L$$, pg_temp.id('bill_new'), pg_temp.id('i_c1')),
  'on a Closed order a Canceled bill is replaced by a valid one');
select is((select status from app.po_instalment_schedule(pg_temp.id('po_c')) where instalment_number = 1), 'Invoiced', 'and the instalment is Invoiced again');
select throws_ok(format($$update app.po_payment_instalments set deleted_at = now() where id = %L$$, pg_temp.id('i_c2')),
  'XR001', 'po_instalment_order_state: A Closed order only links a bill to an unbilled instalment or removes an unbilled instalment.',
  'a linked instalment on a Closed order stays');

select pg_temp.bill('bill_can2', 'cp_rig', 'USD', 1000, '2027-07-07');
select pg_temp.as_user('carol');
select lives_ok(format($$update app.po_payment_instalments set invoice_id = %L, amount_minor = 1000 where id = %L$$, pg_temp.id('bill_can2'), pg_temp.id('i_bal')),
  'an open order''s instalment links a bill');
select pg_temp.move('invoice', 'app.invoices', 'invoice_id', 'bill_can2', 'Approved', 'Disputed');
select pg_temp.move('invoice', 'app.invoices', 'invoice_id', 'bill_can2', 'Disputed', 'Canceled');
select pg_temp.as_user('carol');
select lives_ok(format($$update app.po_payment_instalments set amount_minor = 2000 where id = %L$$, pg_temp.id('i_bal')),
  'a Canceled bill holds no amount (po_instalment_invoiced)');

-- A removable unbilled instalment on a Closed order.
select pg_temp.make_order('po_d', 10000, null, null);
select pg_temp.as_user('bob');
select app.approve_purchase_order(pg_temp.id('po_d'), 'Within limit.');
select pg_temp.as_user('carol');
with x as (insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor)
  values (pg_temp.id('po_d'), 1, 'Balance', '2027-07-01', 5000) returning id) insert into world select 'i_d1', id from x;
select app.transition_purchase_order(pg_temp.id('po_d'), 'Approved', 'Sent', 'Emailed.');
select app.transition_purchase_order(pg_temp.id('po_d'), 'Sent', 'Closed', 'Delivered.');
select lives_ok(format($$update app.po_payment_instalments set deleted_at = now() where id = %L$$, pg_temp.id('i_d1')),
  'an unbilled instalment is removed from a Closed order');

select app.transition_purchase_order(pg_temp.id('po_x'), 'Approved', 'Canceled', 'Vendor withdrew.');
select throws_ok(format($$insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor)
  values (%L, 1, 'Deposit', '2027-06-01', 5000)$$, pg_temp.id('po_x')),
  'XR001', 'po_instalment_order_state: The payment schedule of a Canceled order does not change.',
  'a Canceled order takes nothing');
select pg_temp.as_platform();

select * from finish();
rollback;
