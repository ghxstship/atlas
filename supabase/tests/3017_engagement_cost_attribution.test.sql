-- pgTAP: 3017, engagement attribution of expenses and purchase order lines (B12, RRR-236, gap G-186). An expense or a PO
-- line names a live, non-Canceled engagement of its own project (expense_engagement_project, po_line_engagement_project);
-- a credit names none (expense_credit_engagement); a reimbursed expense keeps it (expense_reimbursed_locked); an Approved
-- or Sent order's line may still change its engagement and nothing else; the tenant guards keep every reference; and
-- private.cost_engagement_for_person attributes by accepted roster entry, then own engagement, else nothing.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 3010_payables_world.psql

select no_plan();

select has_column('app', 'expenses', 'engagement_id', 'an expense names the engagement it is for');
select has_column('app', 'po_lines', 'engagement_id', 'and so does a purchase order line');
select ok((select encode(t.tgargs, 'escape') like '%app.counterparties%app.expenses%credit_of_expense_id%app.expense_reimbursements%app.engagements%engagement_id%'
  from pg_trigger t where t.tgrelid = 'app.expenses'::regclass and t.tgname = 't30_refuse_cross_org_reference'),
  'the expense tenant guard keeps the counterparty, credit and reimbursement and adds the engagement');
select ok((select encode(t.tgargs, 'escape') like '%app.budget_lines%budget_line_id%app.engagements%engagement_id%'
  from pg_trigger t where t.tgrelid = 'app.po_lines'::regclass and t.tgname = 't30_refuse_cross_org_reference'),
  'the PO line tenant guard keeps the budget line and adds the engagement');

-- An engagement on another project of the org, and a canceled one on prj_a.
select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a2'), pg_temp.id('ivy'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-12-01') returning id)
  insert into world select 'eng_ivy_a2', id from x;
with x as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('quinn'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01') returning id)
  insert into world select 'eng_gone', id from x;
select pg_temp.move('engagement', 'app.engagements', 'engagement_id', 'eng_gone', 'Onboarding', 'Canceled');

-- Expenses ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, engagement_id)
  values (%L, 'Agency fee.', '2027-06-10', 25000, 'USD', %L)$$, pg_temp.id('line_a'), pg_temp.id('eng_art_a')),
  'an agency fee names the act''s engagement');
select throws_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, engagement_id)
  values (%L, 'Other show.', '2027-06-10', 100, 'USD', %L)$$, pg_temp.id('line_a'), pg_temp.id('eng_ivy_a2')),
  'XR001', 'expense_engagement_project: An expense is for a live engagement of its budget''s project.',
  'an engagement of another project is refused (expense_engagement_project)');
select throws_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, engagement_id)
  values (%L, 'Canceled act.', '2027-06-10', 100, 'USD', %L)$$, pg_temp.id('line_a'), pg_temp.id('eng_gone')),
  'XR001', 'expense_engagement_project: An expense is for a live engagement of its budget''s project.',
  'and so is a Canceled engagement');
select throws_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, engagement_id)
  values (%L, 'Across orgs.', '2027-06-10', 100, 'USD', %L)$$, pg_temp.id('line_a'), pg_temp.id('eng_ivy_b')),
  'XR001', null, 'and another org''s engagement');
select pg_temp.as_platform();

select pg_temp.expense('backline', 'carol', 'line_a', 30000, '2027-06-11');
select pg_temp.approve('backline');
select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, credit_of_expense_id, engagement_id)
  values (%L, 'Backline refund.', '2027-06-12', 1000, 'USD', %L, %L)$$, pg_temp.id('line_a'), pg_temp.id('backline'), pg_temp.id('eng_art_a')),
  'XR001', 'expense_credit_engagement: A credit follows the expense it credits and names no engagement of its own.',
  'a credit names no engagement of its own (expense_credit_engagement)');
select lives_ok(format($$update app.expenses set engagement_id = %L where id = %L$$, pg_temp.id('eng_art_a'), pg_temp.id('backline')),
  'an approved charge is attributed afterwards');
select pg_temp.as_platform();

select pg_temp.expense('taxi', 'carol', 'line_a', 2000, '2027-06-12', null, true);
select pg_temp.approve('taxi');
select pg_temp.as_user('alice');
select app.record_expense_reimbursement(pg_temp.id('carol'), array[pg_temp.id('taxi')], '2027-06-20');
select pg_temp.as_user('carol');
select throws_ok(format($$update app.expenses set engagement_id = %L where id = %L$$, pg_temp.id('eng_art_a'), pg_temp.id('taxi')),
  'XR001', 'expense_reimbursed_locked: A reimbursed expense keeps what it was for and stays out of Trash; void the reimbursement first.',
  'a reimbursed expense keeps its engagement (expense_reimbursed_locked)');
select pg_temp.as_platform();

-- Purchase order lines -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_rig')) returning id) insert into world select 'v_rig', id from x;
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('v_rig'), 'USD') returning id)
  insert into world select 'po_bk', id from x;
with x as (insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor)
  values (pg_temp.id('po_bk'), 1, 'Drum riser.', 1, 40000) returning id) insert into world select 'pl_bk', id from x;
select throws_ok(format($$insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor, engagement_id)
  values (%L, 2, 'Other show.', 1, 100, %L)$$, pg_temp.id('po_bk'), pg_temp.id('eng_ivy_a2')),
  'XR001', 'po_line_engagement_project: A purchase order line is for a live engagement of the order''s project.',
  'a line for another project''s engagement is refused (po_line_engagement_project)');
select pg_temp.as_user('bob');
select app.approve_purchase_order(pg_temp.id('po_bk'), 'Within limit.');
select pg_temp.as_user('carol');
select lives_ok(format($$update app.po_lines set engagement_id = %L where id = %L$$, pg_temp.id('eng_art_a'), pg_temp.id('pl_bk')),
  'an Approved order''s line is attributed to the act');
select throws_ok(format($$update app.po_lines set engagement_id = %L, unit_price_minor = 1 where id = %L$$, pg_temp.id('eng_vendor_a'), pg_temp.id('pl_bk')),
  'XR001', 'purchase_order_locked: Purchase order lines change only while the order is Proposed; use a PO change order.',
  'but nothing else on the line changes with it');
select throws_ok(format($$update app.po_lines set description = 'Drum riser, 8 by 8.' where id = %L$$, pg_temp.id('pl_bk')),
  'XR001', 'purchase_order_locked: Purchase order lines change only while the order is Proposed; use a PO change order.',
  'and an Approved order''s lines stay locked otherwise');
select app.transition_purchase_order(pg_temp.id('po_bk'), 'Approved', 'Sent', 'Emailed.');
select lives_ok(format($$update app.po_lines set engagement_id = null where id = %L$$, pg_temp.id('pl_bk')), 'a Sent order''s line too');
select app.transition_purchase_order(pg_temp.id('po_bk'), 'Sent', 'Closed', 'Delivered.');
select throws_ok(format($$update app.po_lines set engagement_id = %L where id = %L$$, pg_temp.id('eng_art_a'), pg_temp.id('pl_bk')),
  'XR001', 'purchase_order_locked: Purchase order lines change only while the order is Proposed; use a PO change order.',
  'a Closed order''s line does not');
select pg_temp.as_platform();

-- Attribution by person ----------------------------------------------------------------------------------------------------
select is(private.cost_engagement_for_person(pg_temp.id('prj_a'), pg_temp.id('kai')), pg_temp.id('eng_vendor_a'),
  'a person on an accepted roster entry is attributed to its engagement');
select is(private.cost_engagement_for_person(pg_temp.id('prj_a'), pg_temp.id('una')), null::uuid,
  'a Draft roster entry attributes nothing');
select is(private.cost_engagement_for_person(pg_temp.id('prj_a'), pg_temp.id('art')), pg_temp.id('eng_art_a'),
  'an engaged person is attributed to their own engagement');
select is(private.cost_engagement_for_person(pg_temp.id('prj_a'), pg_temp.id('quinn')), null::uuid,
  'a Canceled engagement attributes nothing');
select is(private.cost_engagement_for_person(pg_temp.id('prj_a'), pg_temp.id('frank')), null::uuid,
  'internal crew are not acts');
select is(private.cost_engagement_for_person(pg_temp.id('prj_a2'), pg_temp.id('ivy')), pg_temp.id('eng_ivy_a2'),
  'on another project, that project''s engagement');
select ok(not has_function_privilege('authenticated', 'private.cost_engagement_for_person(uuid, uuid)', 'execute'),
  'the attribution helper is for definer functions only');

select * from finish();
rollback;
