-- pgTAP: 3010, expense credits and the reimbursable flag (B12, RRR-236, gaps G-223 and G-228). A credit is an expense row
-- naming an Approved or Paid charge on the same line, with the charge's counterparty and a positive amount, never beyond
-- what is left; only the approver's or the payer's side records one. The same checks run when a credit's amount
-- changes, when it is resubmitted and when it is restored from Trash. A credit keeps its counterparty. A charge with
-- standing credits, an Approved or Paid credit and a reimbursed expense stay out of Trash. The reimbursable flag needs a submitter, is never on a credit and is fixed after Proposed,
-- and the reimbursement link changes only inside the reimbursement RPCs.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql
\ir 3010_payables_world.psql

select no_plan();

-- Catalog ------------------------------------------------------------------------------------------------------------------
select has_column('app', 'expenses', 'credit_of_expense_id', 'expenses name the charge a credit is against');
select has_column('app', 'expenses', 'is_reimbursable', 'expenses say whether the submitter paid out of pocket');
select has_column('app', 'expenses', 'reimbursement_id', 'expenses name the reimbursement that settled them');
select has_table('app', 'expense_reimbursements', 'reimbursements are their own records');
select ok(col_description('app.expenses'::regclass, (select attnum from pg_attribute where attrelid = 'app.expenses'::regclass and attname = 'credit_of_expense_id')) is not null
  and col_description('app.expenses'::regclass, (select attnum from pg_attribute where attrelid = 'app.expenses'::regclass and attname = 'is_reimbursable')) is not null
  and col_description('app.expenses'::regclass, (select attnum from pg_attribute where attrelid = 'app.expenses'::regclass and attname = 'reimbursement_id')) is not null,
  'each new column is described');
select ok(has_table_privilege('authenticated', 'app.expense_reimbursements', 'select')
  and not has_table_privilege('authenticated', 'app.expense_reimbursements', 'insert')
  and not has_table_privilege('authenticated', 'app.expense_reimbursements', 'update')
  and not has_table_privilege('authenticated', 'app.expense_reimbursements', 'delete'),
  'signed-in people read reimbursements and write them only through the RPCs');
select ok(exists (select 1 from private.trash_excluded_tables where table_name = 'expense_reimbursements')
  and not exists (select 1 from private.trash_tables where table_name = 'expense_reimbursements'),
  'reimbursements are voided, never restored from Trash');
select ok(exists (select 1 from private.retention_policies where table_name = 'app.expense_reimbursements'),
  'reimbursements carry the default retention');

-- A charge and its credits ---------------------------------------------------------------------------------------------------
select pg_temp.expense('exp_a', 'carol', 'line_a', 12000, '2027-06-10', 'cp_rig');
select pg_temp.approve('exp_a');
select pg_temp.expense('exp_prop', 'carol', 'line_a', 5000, '2027-06-11', 'cp_rig');

select pg_temp.as_user('carol');
select lives_ok($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, credit_of_expense_id)
  values ((select id from world where key = 'line_a'), 'Deck rental refund.', '2027-06-12', 4000, 'USD', (select id from world where key = 'exp_a'))$$,
  'a manager records a credit against an approved charge');
select pg_temp.as_platform();
insert into world select 'cr_1', e.id from app.expenses e where e.credit_of_expense_id = pg_temp.id('exp_a');
select is((select counterparty_id from app.expenses where id = pg_temp.id('cr_1')), pg_temp.id('cp_rig'),
  'the credit takes its original''s counterparty');
select is((select amount_minor from app.expenses where id = pg_temp.id('cr_1')), 4000::bigint, 'its amount stays positive');
select is((select submitter_person_id from app.expenses where id = pg_temp.id('cr_1')), pg_temp.id('carol'),
  'its submitter is the person who recorded it');

select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, credit_of_expense_id)
  values (%L, 'Early refund.', '2027-06-12', 100, 'USD', %L)$$, pg_temp.id('line_a'), pg_temp.id('exp_prop')),
  'XR001', 'expense_credit_original: A credit is against a live Approved or Paid expense of the org that is not itself a credit.',
  'a credit against a Proposed charge is refused (expense_credit_original)');
select throws_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, credit_of_expense_id)
  values (%L, 'Credit on a credit.', '2027-06-12', 100, 'USD', %L)$$, pg_temp.id('line_a'), pg_temp.id('cr_1')),
  'XR001', 'expense_credit_original: A credit is against a live Approved or Paid expense of the org that is not itself a credit.',
  'a credit against a credit is refused');
select throws_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, credit_of_expense_id)
  values (%L, 'Other line.', '2027-06-12', 100, 'USD', %L)$$, pg_temp.id('line_b'), pg_temp.id('exp_a')),
  'XR001', 'expense_credit_line: A credit posts to the budget line of the expense it credits.',
  'a credit on another line is refused (expense_credit_line)');
select throws_like(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, credit_of_expense_id)
  values (%L, 'Too much.', '2027-06-12', 8001, 'USD', %L)$$, pg_temp.id('line_a'), pg_temp.id('exp_a')),
  'expense_credit_exceeds:%', 'credits beyond the charge, counting the Proposed one, are refused (expense_credit_exceeds)');
select throws_ok(format($$update app.expenses set credit_of_expense_id = null where id = %L$$, pg_temp.id('cr_1')),
  'XR001', 'expense_credit_immutable: A credit stays against the expense it credits, and a charge never becomes a credit.',
  'a credit never leaves its original (expense_credit_immutable)');
select throws_ok(format($$update app.expenses set credit_of_expense_id = %L where id = %L$$, pg_temp.id('exp_a'), pg_temp.id('exp_prop')),
  'XR001', 'expense_credit_immutable: A credit stays against the expense it credits, and a charge never becomes a credit.',
  'and a charge never becomes one');
select pg_temp.as_platform();

-- A field crew member files expenses but records no credit.
select pg_temp.as_user('frank');
select throws_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, credit_of_expense_id)
  values (%L, 'Field refund.', '2027-06-12', 100, 'USD', %L)$$, pg_temp.id('line_a'), pg_temp.id('exp_a')),
  '42501', null, 'the Field role cannot record a credit');
select lives_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code)
  values (%L, 'Ice for the crew.', '2027-06-12', 900, 'USD')$$, pg_temp.id('line_a')),
  'while it still files its own expenses');
select pg_temp.as_platform();

-- A credit back in play is checked again ---------------------------------------------------------------------------------------
-- cr_1 is 4000 Proposed. cr_2 takes the remaining 8000 and is rejected; cr_3 then takes 5000.
select pg_temp.expense('cr_2', 'carol', 'line_a', 8000, '2027-06-13', null, false, 'exp_a');
select pg_temp.as_user('bob');
select app.reject_expense(pg_temp.id('cr_2'), 'Not received.');
select pg_temp.as_platform();
select pg_temp.expense('cr_3', 'carol', 'line_a', 5000, '2027-06-13', null, false, 'exp_a');
select pg_temp.as_user('carol');
select throws_like(format($$select app.transition_expense(%L, 'Rejected', 'Proposed', 'Received after all.')$$, pg_temp.id('cr_2')),
  'expense_credit_exceeds:%', 'a rejected credit resubmitted beyond the charge is refused');
select throws_like(format($$update app.expenses set amount_minor = 8500 where id = %L$$, pg_temp.id('cr_3')),
  'expense_credit_exceeds:%', 'a Proposed credit''s amount raised beyond the charge is refused');
select lives_ok(format($$update app.expenses set amount_minor = 3000 where id = %L$$, pg_temp.id('cr_3')),
  'a Proposed credit''s amount lowered within the charge is kept');
select lives_ok(format($$update app.expenses set deleted_at = now() where id = %L$$, pg_temp.id('cr_3')), 'a credit goes to Trash');
select pg_temp.expense('cr_4', 'carol', 'line_a', 8000, '2027-06-14', null, false, 'exp_a');
select pg_temp.as_user('carol');
select throws_like(format($$update app.expenses set deleted_at = null where id = %L$$, pg_temp.id('cr_3')),
  'expense_credit_exceeds:%', 'a credit restored from Trash beyond the charge is refused');
select pg_temp.as_platform();

-- A charge with standing credits stays out of Trash.
select pg_temp.as_user('carol');
select throws_ok(format($$update app.expenses set deleted_at = now() where id = %L$$, pg_temp.id('exp_a')),
  'XR001', 'expense_has_credits: An expense with credits stays out of Trash while they stand; cancel or reject them first.',
  'a charge with standing credits cannot be trashed (expense_has_credits)');
select pg_temp.as_platform();

-- The reimbursable flag -------------------------------------------------------------------------------------------------------
select throws_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, is_reimbursable)
  values (%L, 'No one.', '2027-06-12', 100, 'USD', true)$$, pg_temp.id('line_a')),
  '23514', null, 'a reimbursable expense needs a submitter (expenses_reimbursable_submitter)');
select pg_temp.expense('exp_r', 'carol', 'line_b', 3000, '2027-06-15', null, true);
select is((select is_reimbursable from app.expenses where id = pg_temp.id('exp_r')), true, 'the submitter files a reimbursable expense');
select pg_temp.as_user('carol');
select lives_ok(format($$update app.expenses set is_reimbursable = false where id = %L$$, pg_temp.id('exp_r')),
  'the flag changes while Proposed');
select lives_ok(format($$update app.expenses set is_reimbursable = true where id = %L$$, pg_temp.id('exp_r')), 'and back');
select pg_temp.as_platform();
select pg_temp.approve('exp_r');
select pg_temp.as_user('carol');
select throws_ok(format($$update app.expenses set is_reimbursable = false where id = %L$$, pg_temp.id('exp_r')),
  'XR001', 'expense_reimbursable_locked: Whether an expense is reimbursable changes only while it is Proposed.',
  'the flag is fixed once approved (expense_reimbursable_locked)');
select pg_temp.as_platform();

-- The reimbursement link changes only inside the RPCs.
with x as (insert into app.expense_reimbursements (org_id, payee_person_id, currency_code, paid_minor, paid_on)
  values (pg_temp.id('org_a'), pg_temp.id('carol'), 'USD', 3000, '2027-06-20') returning id)
insert into world select 'reimb_direct', id from x;
select pg_temp.as_user('carol');
select throws_ok(format($$update app.expenses set reimbursement_id = %L where id = %L$$, pg_temp.id('reimb_direct'), pg_temp.id('exp_r')),
  'XR001', 'expense_reimbursement_rpc: An expense is reimbursed through app.record_expense_reimbursement.',
  'a direct link to a reimbursement is refused (expense_reimbursement_rpc)');
select throws_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, is_reimbursable, reimbursement_id)
  values (%L, 'Prepaid.', '2027-06-12', 100, 'USD', true, %L)$$, pg_temp.id('line_b'), pg_temp.id('reimb_direct')),
  'XR001', 'expense_reimbursement_rpc: An expense is reimbursed through app.record_expense_reimbursement.',
  'and so is an expense filed already reimbursed');

-- A reimbursed expense keeps what it was for.
select pg_temp.as_user('alice');
insert into world values ('reimb_r', app.record_expense_reimbursement(pg_temp.id('carol'), array[pg_temp.id('exp_r')], '2027-06-21', 'ACH 4471'));
select pg_temp.as_user('carol');
select throws_ok(format($$update app.expenses set description = 'Something else.' where id = %L$$, pg_temp.id('exp_r')),
  'XR001', 'expense_reimbursed_locked: A reimbursed expense keeps what it was for and stays out of Trash; void the reimbursement first.',
  'a reimbursed expense keeps its description (expense_reimbursed_locked)');
select throws_ok(format($$update app.expenses set counterparty_id = %L where id = %L$$, pg_temp.id('cp_lake'), pg_temp.id('exp_r')),
  'XR001', 'expense_reimbursed_locked: A reimbursed expense keeps what it was for and stays out of Trash; void the reimbursement first.',
  'and its counterparty');
select throws_ok(format($$update app.expenses set deleted_at = now() where id = %L$$, pg_temp.id('exp_r')),
  'XR001', 'expense_reimbursed_locked: A reimbursed expense keeps what it was for and stays out of Trash; void the reimbursement first.',
  'and stays out of Trash');
select pg_temp.as_platform();

-- A refund on a reimbursed expense belongs to its payer.
select pg_temp.as_user('bob');
select throws_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, credit_of_expense_id)
  values (%L, 'Hotel refund.', '2027-06-22', 500, 'USD', %L)$$, pg_temp.id('line_b'), pg_temp.id('exp_r')),
  'XR001', 'expense_credit_reimbursed: This expense was reimbursed to the person who paid it, so a refund on it is theirs.',
  'a credit against a reimbursed expense is refused (expense_credit_reimbursed)');
select pg_temp.as_platform();

-- A Paid charge that was not reimbursed takes credits.
select pg_temp.expense('exp_paid', 'carol', 'line_b', 7000, '2027-06-16', 'cp_lake');
select pg_temp.approve('exp_paid');
select pg_temp.as_user('alice');
select app.transition_expense(pg_temp.id('exp_paid'), 'Approved', 'Paid', 'Paid by card.');
select lives_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, credit_of_expense_id)
  values (%L, 'Card refund.', '2027-06-22', 700, 'USD', %L)$$, pg_temp.id('line_b'), pg_temp.id('exp_paid')),
  'a credit against a Paid charge is recorded by the payer''s side');
select throws_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, is_reimbursable, credit_of_expense_id)
  values (%L, 'Refund to me.', '2027-06-22', 100, 'USD', true, %L)$$, pg_temp.id('line_b'), pg_temp.id('exp_paid')),
  '23514', null, 'a credit is never reimbursable (expenses_credit_not_reimbursable)');
select pg_temp.as_platform();

-- A credit keeps its original's vendor, and a posted credit stays out of Trash: its reversal stays Posted.
select pg_temp.expense('exp_keep', 'carol', 'line_b', 3000, '2027-06-17', 'cp_lake');
select pg_temp.approve('exp_keep');
select pg_temp.expense('cr_keep', 'carol', 'line_b', 400, '2027-06-23', null, false, 'exp_keep');
select pg_temp.as_user('carol');
select is((select counterparty_id from app.expenses where id = pg_temp.id('cr_keep')), pg_temp.id('cp_lake'), 'a credit takes its original''s counterparty');
select throws_ok(format($$update app.expenses set counterparty_id = %L where id = %L$$, pg_temp.id('cp_rig'), pg_temp.id('cr_keep')),
  'XR001', 'expense_credit_immutable: A credit keeps the vendor of the expense it credits.', 'and keeps it while Proposed (expense_credit_immutable)');
select pg_temp.as_platform();
select pg_temp.approve('cr_keep');
select pg_temp.as_user('carol');
select throws_ok(format($$update app.expenses set deleted_at = now() where id = %L$$, pg_temp.id('cr_keep')),
  'XR001', 'expense_credit_posted: An approved credit has posted its reversal, so it stays out of Trash.',
  'an Approved credit stays out of Trash (expense_credit_posted)');
select pg_temp.as_platform();

-- Cross-org: a credit naming another org's charge is refused before any comparison.
select pg_temp.as_user('xavier');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_b'), 'Pier Nights', 'USD') returning id) insert into world select 'bud_b', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_b'), 1, 'Dock.', '0000.01.01', 1, 100, 'X', 'Declared') returning id) insert into world select 'line_xb', id from x;
select throws_ok(format($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, credit_of_expense_id)
  values (%L, 'Foreign credit.', '2027-06-12', 100, 'USD', %L)$$, pg_temp.id('line_xb'), pg_temp.id('exp_a')),
  'XR001', null, 'a credit against another org''s expense is refused');
select pg_temp.as_platform();

select * from finish();
rollback;
