-- pgTAP: 3015, the payments-due ledger (B12, RRR-236, gap G-184; Section 3.7). app.payments_due returns exactly the
-- org's outstanding payables: Proposed and Approved payable bills net of Approved payments with Proposed ones scheduled,
-- an unpriced bill with a NULL amount, a deposit billed through its bill and an unbilled balance on an Approved order,
-- Accepted settlements above what the engagement's bills total, unpaid per diems including a roster entry's, and owed
-- reimbursements and Approved charges due from the local date of approval in the project's time zone. An order's unbilled
-- instalments are offset by bills matched to it and linked to no instalment. It leaves out instalments of Proposed and
-- Canceled orders, paid items, receivables, approved credits and bills billed through a live instalment. It refuses a
-- reader without all five capabilities at organization reach, reads no name from app.people, and p_project_id narrows it.
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
create function pg_temp.settlement(p_key text, p_engagement text, p_guarantee bigint, p_withholding bigint,
  p_on date default '2027-06-06', p_currency text default 'USD') returns void
language plpgsql as $$
declare
  v uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.settlements (engagement_id, project_id, title, currency_code, settled_on)
  values (pg_temp.id(p_engagement), pg_temp.id('prj_a'), 'Opening night', p_currency, p_on) returning id into v;
  insert into world values (p_key, v);
  insert into app.settlement_lines (settlement_id, line_number, line_kind, description, amount_minor) values
    (v, 1, 'Guarantee', 'Guarantee.', p_guarantee), (v, 2, 'Withholding', 'State withholding.', p_withholding);
  perform pg_temp.move('settlement', 'app.settlements', 'settlement_id', p_key, 'Proposed', 'Submitted');
  perform pg_temp.move('settlement', 'app.settlements', 'settlement_id', p_key, 'Submitted', 'Accepted');
end $$;
-- art billed 50.00 against a 500.00 settlement: both are owed, the settlement at 450.00.
select pg_temp.settlement('st_art', 'eng_art_a', 50000, 0);
select pg_temp.bill('bill_art', null, 'USD', 5000, '2027-06-07', 'Proposed', 'art', 'eng_art_a');
-- ivy billed her settled fee: the bill is what is owed. A later settlement starts after it, at its net of withholding.
select pg_temp.settlement('st_ivy', 'eng_ivy_a', 20000, 0);
select pg_temp.bill('bill_ivy', null, 'USD', 20000, '2027-06-08', 'Proposed', 'ivy', 'eng_ivy_a');
select pg_temp.settlement('st_ivy2', 'eng_ivy_a', 4000, 1000, '2027-06-07');
-- A bill with no price makes what is billed unknown, so the settlement beside it has no amount.
select pg_temp.settlement('st_bay', 'eng_vendor_a', 100000, 10000);
select pg_temp.bill('bill_bay', 'cp_v_a', 'USD', null, '2027-06-09', 'Proposed', null, 'eng_vendor_a');
-- An earlier settlement with no price leaves every later one without an amount, in that currency only.
select pg_temp.settlement('st_art_e1', 'eng_art_a', null, 0, '2027-06-01', 'EUR');
select pg_temp.settlement('st_art_e2', 'eng_art_a', 3000, 0, '2027-06-02', 'EUR');

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

-- Bills matched to an order and linked to no instalment --------------------------------------------------------------------
create function pg_temp.matched_order(p_key text, p_instalment bigint, p_bill_key text, p_bill bigint) returns void
language plpgsql as $$
declare
  v uuid;
  v_receipt uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('v_rig'), 'USD') returning id into v;
  insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values (v, 1, 'Crew catering.', 1, 100000);
  perform pg_temp.as_user('bob');
  perform app.approve_purchase_order(v, 'Within limit.');
  perform pg_temp.as_user('carol');
  insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor)
  values (v, 1, 'Balance', '2027-07-02', p_instalment);
  insert into app.goods_receipts (purchase_order_id) values (v) returning id into v_receipt;
  perform pg_temp.as_platform();
  insert into world values (p_key, v);
  insert into world select p_key || '_i', i.id from app.po_payment_instalments i where i.purchase_order_id = v;
  perform pg_temp.bill(p_bill_key, 'cp_rig', 'USD', p_bill, '2027-07-03', 'Proposed');
  perform pg_temp.as_user('carol');
  insert into app.invoice_matches (invoice_id, purchase_order_id, goods_receipt_id) values (pg_temp.id(p_bill_key), v, v_receipt);
  perform pg_temp.as_platform();
end $$;
select pg_temp.matched_order('po_m1', 40000, 'bill_m1', 40000);
select pg_temp.matched_order('po_m2', 50000, 'bill_m2', 20000);
select pg_temp.matched_order('po_m3', 30000, 'bill_m3', null);
-- A Canceled order's instalments are not owed.
select pg_temp.as_user('carol');
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('v_rig'), 'USD') returning id)
  insert into world select 'po_gone', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values (pg_temp.id('po_gone'), 1, 'Withdrawn.', 1, 10000);
select pg_temp.as_user('bob');
select app.approve_purchase_order(pg_temp.id('po_gone'), 'Within limit.');
select pg_temp.as_user('carol');
with x as (insert into app.po_payment_instalments (purchase_order_id, instalment_number, label, due_on, amount_minor)
  values (pg_temp.id('po_gone'), 1, 'Deposit', '2027-06-01', 10000) returning id) insert into world select 'i_gone', id from x;
select app.transition_purchase_order(pg_temp.id('po_gone'), 'Approved', 'Canceled', 'Vendor withdrew.');

-- Reimbursements and approved charges ---------------------------------------------------------------------------------------
select pg_temp.expense('r_due', 'carol', 'line_a', 3000, '2027-06-10', null, true);
select pg_temp.approve('r_due');
select pg_temp.expense('r_wait', 'carol', 'line_a', 1000, '2027-06-11', null, true);
select pg_temp.expense('x_vendor', 'carol', 'line_a', 900, '2027-06-11', 'cp_lake');
select pg_temp.approve('x_vendor');
select pg_temp.expense('x_vendor_cr', 'carol', 'line_a', 100, '2027-06-12', null, false, 'x_vendor');
select pg_temp.approve('x_vendor_cr');
select pg_temp.expense('x_zero', 'carol', 'line_a', 200, '2027-06-11', 'cp_lake');
select pg_temp.approve('x_zero');
select pg_temp.expense('x_zero_cr', 'carol', 'line_a', 200, '2027-06-12', null, false, 'x_zero');
select pg_temp.approve('x_zero_cr');
select pg_temp.expense('x_paid', 'carol', 'line_a', 200, '2027-06-11', 'cp_lake');
select pg_temp.approve('x_paid');
select pg_temp.as_user('alice');
select app.transition_expense(pg_temp.id('x_paid'), 'Approved', 'Paid', 'Paid by card.');

-- The ledger ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
create temporary table due (kind text, source_id uuid, purchase_order_id uuid, project_id uuid, project_key text, project_today date,
  counterparty_id uuid, counterparty_name text, payee_person_id uuid, label text, due_on date, currency_code text, amount_minor bigint,
  scheduled_minor bigint, billed_offset_minor bigint, source_state text);
grant all on due to public;
select pg_temp.as_user('alice');
insert into due select * from app.payments_due(pg_temp.id('org_a'), pg_temp.id('prj_a'));
select pg_temp.as_platform();
select is((select string_agg(kind || ':' || coalesce(w.key, '?'), ',' order by kind, w.key collate "C")
  from due d left join world w on w.id = d.source_id),
  'expense:x_vendor,instalment:i_balance_2,instalment:i_deposit_1,instalment:po_m2_i,instalment:po_m3_i,invoice:bill_appr,invoice:bill_art,'
  || 'invoice:bill_bay,invoice:bill_blank,invoice:bill_ivy,invoice:bill_m1,invoice:bill_m2,invoice:bill_m3,invoice:bill_prop,invoice:bill_prop2,'
  || 'per_diem:pd_dave,per_diem:pd_kai,reimbursement:r_due,settlement:st_art,settlement:st_art_e1,settlement:st_art_e2,settlement:st_bay,settlement:st_ivy2',
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
select is((select purchase_order_id from due where source_id = pg_temp.id('i_balance_2')), pg_temp.id('po_due'), 'an instalment names its order');
select is((select string_agg(distinct kind, ',') from due where purchase_order_id is null and kind = 'instalment'), null::text, 'every instalment does');
select is((select amount_minor || '/' || due_on || '/' || payee_person_id || '/' || billed_offset_minor from due where source_id = pg_temp.id('st_art')),
  '45000/2027-06-06/' || pg_temp.id('art') || '/5000', 'a 500.00 settlement beside a 50.00 bill is owed 450.00 to the engaged party');
select is((select amount_minor from due where source_id = pg_temp.id('bill_art')), 5000::bigint, 'and the bill is owed its 50.00');
select ok(not exists (select 1 from due where source_id = pg_temp.id('st_ivy')), 'a settlement a bill covers in full leaves only the bill');
select is((select amount_minor || '/' || billed_offset_minor from due where source_id = pg_temp.id('st_ivy2')), '3000/0',
  'the earlier settlement used the bill up, so a later one is owed its net of withholding');
select is((select amount_minor from due where source_id = pg_temp.id('st_bay')), null::bigint, 'an unpriced bill makes the settlement beside it unknown');
select is((select amount_minor from due where source_id = pg_temp.id('st_art_e1')), null::bigint, 'an unpriced settlement has no amount');
select is((select amount_minor from due where source_id = pg_temp.id('st_art_e2')), null::bigint, 'and neither has a later one, though it has a price');
select ok(not exists (select 1 from due where source_id = pg_temp.id('i_gone')), 'a Canceled order''s instalments are not owed');
select ok(not exists (select 1 from due where source_id = pg_temp.id('po_m1_i')), 'a matched, unlinked bill for the whole of an unbilled balance lists only the bill');
select is((select amount_minor from due where source_id = pg_temp.id('bill_m1')), 40000::bigint, 'which is owed in full');
select is((select amount_minor || '/' || billed_offset_minor from due where source_id = pg_temp.id('po_m2_i')), '30000/20000',
  'a matched bill for part of a balance takes that part off');
select is((select amount_minor from due where source_id = pg_temp.id('po_m3_i')), null::bigint, 'an unpriced matched bill leaves the instalment unknown');
select is((select payee_person_id from due where source_id = pg_temp.id('pd_kai')), pg_temp.id('kai'),
  'a roster per diem is owed to the entry''s person');
select is((select amount_minor || '/' || payee_person_id from due where source_id = pg_temp.id('r_due')), '3000/' || pg_temp.id('carol'),
  'a reimbursement is owed to its submitter');
select is((select amount_minor || '/' || counterparty_name from due where source_id = pg_temp.id('x_vendor')), '800/Lakeshore Brands',
  'an Approved charge is owed to its vendor at its net of approved credits');
select ok(not exists (select 1 from due where source_id in (pg_temp.id('x_zero'), pg_temp.id('x_zero_cr'), pg_temp.id('x_vendor_cr'), pg_temp.id('x_paid'))),
  'never a charge credited to nothing, a Paid charge or a credit, which is a refund coming in');
select is((select count(*)::int from due where due_on is null), 0, 'every row here has a date');
select is((select count(*)::int from due where project_today is distinct from private.project_today(project_id)), 0, 'each row carries its project''s day');
select ok(position('app.people' in pg_get_functiondef('app.payments_due(uuid, uuid)'::regprocedure)) = 0, 'no name is read from app.people');

-- Narrowing and refusals ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select is((select string_agg(source_id::text, ',') from app.payments_due(pg_temp.id('org_a'), pg_temp.id('prj_a2'))), pg_temp.id('pd_a2')::text,
  'p_project_id narrows the ledger to one project');
select ok((select count(*) from app.payments_due(pg_temp.id('org_a'))) = (select count(*) from due) + 1, 'without it the whole org is read');
select is(app.can_read_payments_due(pg_temp.id('org_a')), true, 'an owner reads the ledger');
select pg_temp.as_user('gina');
select is(app.can_read_payments_due(pg_temp.id('org_a')), false, 'a viewer does not');
select throws_ok(format($$select * from app.payments_due(%L)$$, pg_temp.id('org_a')), '42501', null, 'and is refused');
select pg_temp.as_user('xavier');
select throws_ok(format($$select * from app.payments_due(%L)$$, pg_temp.id('org_a')), '42501', null, 'another org reads none of it');
select pg_temp.as_platform();

-- Each of the five capabilities is needed: the member holds them all at organization reach, until one is taken away.
create function pg_temp.check_capability(p_capability text) returns setof text
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  delete from app.role_capabilities where role_id = pg_temp.system_role('member') and capability_code = p_capability;
  perform pg_temp.as_user('dave');
  return next ok(not app.can_read_payments_due(pg_temp.id('org_a')), 'the ledger needs ' || p_capability);
  return next throws_ok(format($q$select * from app.payments_due(%L)$q$, pg_temp.id('org_a')), '42501', null, 'and refuses without ' || p_capability);
  perform pg_temp.as_platform();
  insert into app.role_capabilities (role_id, capability_code, reach) values (pg_temp.system_role('member'), p_capability, 'organization');
end $$;
select pg_temp.as_user('dave');
select ok(app.can_read_payments_due(pg_temp.id('org_a')), 'a member holds all five');
select r from unnest(array['finance.payment.read', 'finance.invoice.read', 'finance.expense.read', 'procurement.po.read', 'crew.time_entry.read']) c, pg_temp.check_capability(c) r;

-- Each project's day: Pago Pago and Kiritimati are 25 hours apart, so their dates differ at every instant ----------------------
update app.projects set time_zone = 'Pacific/Pago_Pago' where id = pg_temp.id('prj_a');
update app.projects set time_zone = 'Pacific/Kiritimati' where id = pg_temp.id('prj_a2');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a2'), 'Winter Gala Budget', 'USD') returning id)
  insert into world select 'bud2', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud2'), 1, 'Ballroom.', '0000.01.01', 1, 90000, 'X', 'Declared') returning id) insert into world select 'line_2', id from x;
select pg_temp.expense('z_west', 'carol', 'line_a', 700, '2027-06-11', null, true);
select pg_temp.approve('z_west');
select pg_temp.expense('z_east', 'carol', 'line_2', 700, '2027-06-11', null, true);
select pg_temp.approve('z_east');
select pg_temp.as_user('alice');
truncate due;
insert into due select * from app.payments_due(pg_temp.id('org_a'));
select pg_temp.as_platform();
select is((select due_on from due where source_id = pg_temp.id('z_west')),
  (select private.zone_date(t.created_at, 'Pacific/Pago_Pago') from app.expense_state_transitions t where t.expense_id = pg_temp.id('z_west') and t.to_state = 'Approved'),
  'due on the date of approval in Pago Pago');
select is((select due_on from due where source_id = pg_temp.id('z_east')),
  (select private.zone_date(t.created_at, 'Pacific/Kiritimati') from app.expense_state_transitions t where t.expense_id = pg_temp.id('z_east') and t.to_state = 'Approved'),
  'and in Kiritimati');
select ok((select due_on from due where source_id = pg_temp.id('z_west')) <> (select due_on from due where source_id = pg_temp.id('z_east')),
  'the same instant falls on two dates');
select is((select project_today from due where source_id = pg_temp.id('z_west')), private.zone_today('Pacific/Pago_Pago'), 'project_today is Pago Pago''s date');
select is((select project_today from due where source_id = pg_temp.id('z_east')), private.zone_today('Pacific/Kiritimati'), 'and Kiritimati''s');

-- A void keeps the original due date: the void's own move to Approved does not count.
select is((select due_on from due where source_id = pg_temp.id('r_due')),
  (select private.zone_date(t.created_at, 'Pacific/Pago_Pago') from app.expense_state_transitions t where t.expense_id = pg_temp.id('r_due') and t.to_state = 'Approved'),
  'r_due is due from its approval');
select pg_temp.as_user('alice');
insert into world select 'reimb', app.record_expense_reimbursement(pg_temp.id('carol'), array[pg_temp.id('r_due')], '2027-06-20');
select ok(not exists (select 1 from app.payments_due(pg_temp.id('org_a')) d where d.source_id = pg_temp.id('r_due')), 'a reimbursed charge is no longer due');
select app.void_expense_reimbursement(pg_temp.id('reimb'), 'Bank returned it.');
select pg_temp.as_platform();
alter table app.expense_state_transitions disable trigger user;
update app.expense_state_transitions set created_at = created_at - interval '40 days'
where expense_id = pg_temp.id('r_due') and from_state = 'Proposed' and to_state = 'Approved';
alter table app.expense_state_transitions enable trigger user;
select pg_temp.as_user('alice');
truncate due;
insert into due select * from app.payments_due(pg_temp.id('org_a'));
select pg_temp.as_platform();
select is((select due_on from due where source_id = pg_temp.id('r_due')),
  private.zone_date(now() - interval '40 days', 'Pacific/Pago_Pago'),
  'after a void it is due from the first approval, not from the void');

select * from finish();
rollback;
