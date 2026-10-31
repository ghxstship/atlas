-- pgTAP: 3015, the payments-due ledger (B12, RRR-236, gap G-184; Section 3.7). app.payments_due returns exactly the
-- org's outstanding payables: Proposed and Approved payable bills net of Approved payments with Proposed ones scheduled,
-- an unpriced bill with a NULL amount, a deposit billed through its bill and an unbilled balance on an Approved order,
-- an Accepted settlement, unpaid per diems including a roster entry's, and an owed reimbursement due from the day it was
-- approved. It leaves out instalments of Proposed orders, paid items, receivables, bills billed through a live
-- instalment, and an Accepted settlement its engaged party billed. It needs finance.payment.read, and p_project_id narrows
-- it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 3010_payables_world.psql

select no_plan();

-- Bills --------------------------------------------------------------------------------------------------------------------
select pg_temp.bill('bill_prop', 'cp_rig', 'USD', 40000, '2027-06-10', 'Proposed');
select pg_temp.bill('bill_appr', 'cp_rig', 'USD', 30000, '2027-06-12');
select pg_temp.pay('pay_appr', 'cp_rig', 'bill_appr', 5000, true);
select pg_temp.pay('pay_sched', 'cp_rig', 'bill_appr', 10000, false);
select pg_temp.bill('bill_blank', 'cp_lake', 'USD', null, '2027-06-20', 'Proposed');
select pg_temp.bill('bill_paid', 'cp_rig', 'USD', 1000, '2027-06-01');
select pg_temp.pay('pay_full', 'cp_rig', 'bill_paid', 1000, true);
select pg_temp.bill('bill_gone', 'cp_rig', 'USD', 1000, '2027-06-01', 'Canceled');
-- A receivable is not owed.
select pg_temp.as_user('carol');
with x as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code, due_on)
  values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_lake'), 'NWL-INV-9', 'USD', '2027-06-15') returning id)
  insert into world select 'inv_recv', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor, urid)
  values (pg_temp.id('inv_recv'), 1, 'Sponsorship.', 1, 90000, '0000.01.01');

-- Orders and instalments ---------------------------------------------------------------------------------------------------
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_rig')) returning id) insert into world select 'v_rig', id from x;
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('v_rig'), 'USD') returning id)
  insert into world select 'po_due', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values (pg_temp.id('po_due'), 1, 'Truss package.', 1, 100000);
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('v_rig'), 'USD') returning id)
  insert into world select 'po_prop', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values (pg_temp.id('po_prop'), 1, 'Spare truss.', 1, 20000);
select pg_temp.as_user('bob');
select app.approve_purchase_order(pg_temp.id('po_due'), 'Within limit.');
select pg_temp.bill('bill_dep', 'cp_rig', 'USD', 40000, '2027-06-03');
select pg_temp.bill('bill_prop2', 'cp_rig', 'USD', 20000, '2027-06-25');
select pg_temp.as_user('carol');
insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor, invoice_id) values
  (pg_temp.id('po_due'), 1, 'Deposit', '2027-06-01', 40000, pg_temp.id('bill_dep')),
  (pg_temp.id('po_due'), 2, 'Balance', '2027-07-01', 60000, null),
  (pg_temp.id('po_prop'), 1, 'Deposit', '2027-06-20', 20000, pg_temp.id('bill_prop2'));
insert into world select 'i_' || lower(i.label) || '_' || i.instalment_number, i.id from app.po_payment_instalments i
where i.purchase_order_id = pg_temp.id('po_due');

-- Settlements --------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
create function pg_temp.settlement(p_key text, p_engagement text, p_guarantee bigint, p_withholding bigint) returns void
language plpgsql as $$
declare
  v uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.settlements (engagement_id, project_id, title, currency_code, settled_on)
  values (pg_temp.id(p_engagement), pg_temp.id('prj_a'), 'Opening night', 'USD', '2027-06-06') returning id into v;
  insert into world values (p_key, v);
  insert into app.settlement_lines (settlement_id, line_number, line_kind, description, amount_minor) values
    (v, 1, 'Guarantee', 'Guarantee.', p_guarantee), (v, 2, 'Withholding', 'State withholding.', p_withholding);
  perform pg_temp.move('settlement', 'app.settlements', 'settlement_id', p_key, 'Proposed', 'Submitted');
  perform pg_temp.move('settlement', 'app.settlements', 'settlement_id', p_key, 'Submitted', 'Accepted');
end $$;
select pg_temp.settlement('st_art', 'eng_art_a', 100000, 10000);
select pg_temp.settlement('st_ivy', 'eng_ivy_a', 20000, 0);
-- ivy billed her settled fee: the bill is what is owed.
select pg_temp.bill('bill_ivy', null, 'USD', 20000, '2027-06-08', 'Proposed', 'ivy', 'eng_ivy_a');

-- Per diems ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.per_diems (project_id, membership_id, day, amount_minor, currency_code)
  values (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), '2027-06-02', 5000, 'USD') returning id) insert into world select 'pd_dave', id from x;
with x as (insert into app.per_diems (project_id, membership_id, day, amount_minor, currency_code)
  values (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), '2027-06-03', 5000, 'USD') returning id) insert into world select 'pd_paid', id from x;
with x as (insert into app.per_diems (project_id, membership_id, day, amount_minor, currency_code)
  values (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), '2027-06-04', 0, 'USD') returning id) insert into world select 'pd_zero', id from x;
with x as (insert into app.per_diems (project_id, roster_entry_id, day, amount_minor, currency_code)
  values (pg_temp.id('prj_a'), pg_temp.id('e_kai'), '2027-06-02', 4500, 'USD') returning id) insert into world select 'pd_kai', id from x;
with x as (insert into app.per_diems (project_id, membership_id, day, amount_minor, currency_code)
  values (pg_temp.id('prj_a2'), pg_temp.id('dave@org_a'), '2027-06-02', 5000, 'USD') returning id) insert into world select 'pd_a2', id from x;
select pg_temp.as_user('alice');
select app.record_per_diem_payments(array[pg_temp.id('pd_paid')], '2027-06-05');

-- Reimbursements -----------------------------------------------------------------------------------------------------------
select pg_temp.expense('r_due', 'carol', 'line_a', 3000, '2027-06-10', null, true);
select pg_temp.approve('r_due');
select pg_temp.expense('r_wait', 'carol', 'line_a', 1000, '2027-06-11', null, true);

-- The ledger ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
create temporary table due (kind text, source_id uuid, project_id uuid, project_key text, counterparty_id uuid,
  payee_person_id uuid, payee_name text, label text, due_on date, currency_code text, amount_minor bigint,
  scheduled_minor bigint, source_state text);
grant all on due to public;
select pg_temp.as_user('alice');
insert into due select * from app.payments_due(pg_temp.id('org_a'), pg_temp.id('prj_a'));
select pg_temp.as_platform();
select is((select string_agg(kind || ':' || coalesce(w.key, '?'), ',' order by kind, w.key)
  from due d left join world w on w.id = d.source_id),
  'instalment:i_balance_2,instalment:i_deposit_1,invoice:bill_appr,invoice:bill_blank,invoice:bill_ivy,invoice:bill_prop,invoice:bill_prop2,'
  || 'per_diem:pd_dave,per_diem:pd_kai,reimbursement:r_due,settlement:st_art',
  'exactly the outstanding payables of the project');
select is((select amount_minor || '/' || scheduled_minor || '/' || source_state from due where source_id = pg_temp.id('bill_appr')),
  '25000/10000/Approved', 'a bill nets Approved payments, and Proposed ones are scheduled');
select is((select amount_minor || '/' || due_on from due where source_id = pg_temp.id('bill_prop')), '40000/2027-06-10',
  'a Proposed bill is owed in full on its due date');
select is((select amount_minor from due where source_id = pg_temp.id('bill_blank')), null::bigint, 'an unpriced bill has no amount');
select is((select amount_minor || '/' || due_on || '/' || label from due where source_id = pg_temp.id('i_deposit_1')),
  '40000/2027-06-03/Deposit · PO ' || (select po_number from app.purchase_orders where id = pg_temp.id('po_due')),
  'a billed deposit shows its bill''s outstanding amount and due date, once');
select is((select amount_minor || '/' || due_on from due where source_id = pg_temp.id('i_balance_2')), '60000/2027-07-01',
  'an unbilled balance is owed on its own date');
select ok(not exists (select 1 from due where source_id = pg_temp.id('bill_dep')), 'the deposit bill is not listed a second time');
select ok(exists (select 1 from due where source_id = pg_temp.id('bill_prop2') and kind = 'invoice'),
  'a bill linked only to a Proposed order''s instalment stays a bill');
select is((select amount_minor || '/' || due_on || '/' || payee_person_id from due where source_id = pg_temp.id('st_art')),
  '90000/2027-06-06/' || pg_temp.id('art'), 'an Accepted settlement is owed its net to the engaged party on its date');
select ok(not exists (select 1 from due where source_id = pg_temp.id('st_ivy')), 'a settlement the party billed is left out for its bill');
select is((select payee_person_id from due where source_id = pg_temp.id('pd_kai')), pg_temp.id('kai'),
  'a roster per diem is owed to the entry''s person');
select is((select due_on from due where source_id = pg_temp.id('r_due')),
  private.zone_date(now(), private.org_time_zone(pg_temp.id('org_a'))), 'a reimbursement is due from the org-calendar day it was approved');
select is((select amount_minor || '/' || payee_person_id from due where source_id = pg_temp.id('r_due')), '3000/' || pg_temp.id('carol'),
  'owed to its submitter');
select is((select count(*)::int from due where due_on is null), 0, 'every row here has a date');

-- Narrowing and refusals ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select is((select string_agg(source_id::text, ',') from app.payments_due(pg_temp.id('org_a'), pg_temp.id('prj_a2'))), pg_temp.id('pd_a2')::text,
  'p_project_id narrows the ledger to one project');
select ok((select count(*) from app.payments_due(pg_temp.id('org_a'))) = (select count(*) from due) + 1, 'without it the whole org is read');
select pg_temp.as_user('gina');
select throws_ok(format($$select * from app.payments_due(%L)$$, pg_temp.id('org_a')), '42501', null, 'the ledger needs finance.payment.read');
select pg_temp.as_user('xavier');
select throws_ok(format($$select * from app.payments_due(%L)$$, pg_temp.id('org_a')), '42501', null, 'another org reads none of it');
select pg_temp.as_platform();

select * from finish();
rollback;
