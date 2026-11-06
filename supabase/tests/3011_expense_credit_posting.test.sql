-- pgTAP: 3011, credit posting and Actual net of credits (B12, RRR-236, gap G-223). Approving a credit keeps the charge's
-- eligibility (finance.expense.approve, sod_expense_submitter against the credit's own submitter, Proposed only, spend
-- authority) and posts one balanced entry that reverses the original's posted account and dimensions, dated the credit's
-- incurred_on. A charge still posts as 1611 posts it. Actual nets approved and paid credits in every budget read, and
-- app.expense_balances reports each expense's balance, withheld from a reader who cannot read the credits.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql
\ir 3010_payables_world.psql

select no_plan();

-- A 120.00 charge, approved and posted ------------------------------------------------------------------------------------
select pg_temp.expense('exp_a', 'carol', 'line_a', 12000, '2027-06-10', 'cp_rig');
select pg_temp.approve('exp_a');
select is((select count(*)::int from app.journal_entries where source_table = 'expenses' and source_id = pg_temp.id('exp_a') and journal_state = 'Posted'),
  1, 'the charge posts one entry, as 1611 posts it');
select is((select account_code from app.journal_lines l join app.journal_entries j on j.id = l.journal_entry_id
  where j.source_id = pg_temp.id('exp_a') and l.line_number = 1), '5000', 'its debit is the line''s class account');
select is((select actual_minor::bigint from app.budget_line_amounts where budget_line_id = pg_temp.id('line_a')), 12000::bigint,
  'Actual holds the approved charge');

-- Change the line's cost center after posting: the credit reverses what the original posted, not today's line.
select pg_temp.as_user('carol');
with x as (insert into app.cost_centers (org_id, code, name, kind) values (pg_temp.id('org_a'), 'CC-TOUR', 'Touring', 'Standing') returning id)
  insert into world select 'cc_tour', id from x;
update app.budget_lines set cost_center_id = pg_temp.id('cc_tour') where id = pg_temp.id('line_a');
select pg_temp.as_platform();

-- A 40.00 credit -------------------------------------------------------------------------------------------------------------
select pg_temp.expense('cr_a', 'carol', 'line_a', 4000, '2027-07-02', null, false, 'exp_a');
select is((select actual_minor::bigint from app.budget_line_amounts where budget_line_id = pg_temp.id('line_a')), 12000::bigint,
  'a Proposed credit changes nothing');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.approve_expense(%L, 'Self.')$$, pg_temp.id('cr_a')),
  'XR001', 'sod_expense_submitter: The submitter of an expense cannot approve it.', 'the credit''s own submitter cannot approve it');
select pg_temp.as_user('dave');
select throws_ok(format($$select app.approve_expense(%L, 'Member.')$$, pg_temp.id('cr_a')), '42501', null,
  'approving a credit needs finance.expense.approve on the project');
select pg_temp.as_platform();
select is(pg_temp.approve('cr_a'), true, 'an admin approves the credit within spend authority');
select is(pg_temp.expense_state('cr_a'), 'Approved', 'the credit is Approved');
select pg_temp.as_user('bob');
select throws_ok(format($$select app.approve_expense(%L, 'Again.')$$, pg_temp.id('cr_a')),
  'XR001', 'expense_state_conflict: Only a Proposed expense can be approved.', 'only a Proposed credit is approved');
select pg_temp.as_platform();

create temporary table credit_entry as
select j.* from app.journal_entries j where j.source_table = 'expenses' and j.source_id = pg_temp.id('cr_a');
select is((select count(*)::int from credit_entry where journal_state = 'Posted'), 1, 'the credit posts one Posted entry');
select is((select entry_date from credit_entry), '2027-07-02'::date, 'dated the credit''s incurred_on');
select is((select accounting_period_id from credit_entry), pg_temp.id('per_jul'), 'in the period covering that date');
select is((select memo from credit_entry), 'Credit: Cr A.', 'its memo names it a credit');
select is((select account_code || ':' || debit_minor || ':' || credit_minor from app.journal_lines
  where journal_entry_id = (select id from credit_entry) and line_number = 1), '2000:4000:0', 'line 1 debits Accounts Payable');
select is((select account_code || ':' || debit_minor || ':' || credit_minor from app.journal_lines
  where journal_entry_id = (select id from credit_entry) and line_number = 2), '5000:0:4000', 'line 2 credits the original''s account');
select is((select cost_center_id from app.journal_lines where journal_entry_id = (select id from credit_entry) and line_number = 2),
  pg_temp.id('cc_venue'), 'with the cost center the original posted, not the line''s current one');
select is((select counterparty_id from app.journal_lines where journal_entry_id = (select id from credit_entry) and line_number = 2),
  pg_temp.id('cp_rig'), 'and the original''s counterparty');
select is((select cost_center_id from app.journal_lines where journal_entry_id = (select id from credit_entry) and line_number = 1),
  pg_temp.id('cc_venue'), 'Accounts Payable takes the dimensions of the original''s Accounts Payable line');
select is((select sum(debit_minor) - sum(credit_minor) from app.journal_lines where journal_entry_id = (select id from credit_entry))::bigint,
  0::bigint, 'the entry balances');

-- Actual nets the credit everywhere --------------------------------------------------------------------------------------------
select is((select actual_minor::bigint from app.budget_line_amounts where budget_line_id = pg_temp.id('line_a')), 8000::bigint,
  'budget_line_amounts: 120.00 less the 40.00 credit');
select is((select actual_minor::bigint from app.budget_totals where budget_id = pg_temp.id('bud')), 8000::bigint, 'budget_totals nets it');
select is((select actual_minor::bigint from app.budget_revised_totals where budget_id = pg_temp.id('bud')), 8000::bigint,
  'budget_revised_totals nets it');
select is((select actual_minor::bigint from app.budget_line_facts where budget_line_id = pg_temp.id('line_a')), 8000::bigint,
  'budget_line_facts nets it, so the grid, budget versus actual and the final cost report do');

-- A Rejected and a Canceled credit never count.
select pg_temp.expense('cr_rej', 'carol', 'line_a', 1000, '2027-07-03', null, false, 'exp_a');
select pg_temp.as_user('bob');
select app.reject_expense(pg_temp.id('cr_rej'), 'No refund came.');
select pg_temp.as_platform();
select pg_temp.expense('cr_can', 'carol', 'line_a', 1000, '2027-07-03', null, false, 'exp_a');
select pg_temp.as_user('carol');
select app.transition_expense(pg_temp.id('cr_can'), 'Proposed', 'Canceled', 'Entered twice.');
select pg_temp.as_platform();
select is((select actual_minor::bigint from app.budget_line_amounts where budget_line_id = pg_temp.id('line_a')), 8000::bigint,
  'Rejected and Canceled credits never count');

-- An original with no posted entry ---------------------------------------------------------------------------------------------
-- An Approved charge moved by the lifecycle engine alone, as no RPC would leave it, has nothing posted.
select pg_temp.expense('exp_b', 'carol', 'line_b', 5000, '2027-06-12');
select private.transition_lifecycle('expense', 'app.expenses', 'expense_state', 'app.expense_state_transitions',
  'expense_id', pg_temp.id('exp_b'), 'Proposed', 'Approved', 'Fixture: approved without a posting.');
select pg_temp.expense('cr_b', 'carol', 'line_b', 500, '2027-06-13', null, false, 'exp_b');
select pg_temp.as_user('bob');
select throws_ok(format($$select app.approve_expense(%L, 'No entry.')$$, pg_temp.id('cr_b')),
  'XR001', 'expense_credit_original_unposted: The expense this credit is against has no posted entry to reverse.',
  'a credit whose original has no posted entry is refused (expense_credit_original_unposted)');
select pg_temp.as_platform();

-- Balances ---------------------------------------------------------------------------------------------------------------------
select has_view('app', 'expense_balances', 'app.expense_balances exists');
select ok((select reloptions @> array['security_invoker=true'] from pg_class where oid = 'app.expense_balances'::regclass),
  'it is security invoker');
select ok(not has_table_privilege('xos_backup', 'app.expense_balances', 'select'), 'the backup login has no SELECT on it (1650)');
select ok(not has_table_privilege('anon', 'app.expense_balances', 'select'), 'anonymous callers cannot read it');

select pg_temp.expense('cr_pend', 'carol', 'line_a', 1500, '2027-07-04', null, false, 'exp_a');
select pg_temp.as_user('carol');
select is((select credited_minor || '/' || pending_credit_minor || '/' || net_minor || '/' || creditable_minor
  from app.expense_balances where expense_id = pg_temp.id('exp_a')), '4000/1500/8000/6500',
  'a charge reports credited, pending, net and creditable');
select is((select is_credit::text || '/' || net_minor || '/' || coalesce(creditable_minor::text, 'null')
  from app.expense_balances where expense_id = pg_temp.id('cr_a')), 'true/-4000/null', 'a credit nets negative and is not creditable');
select is((select coalesce(reimbursement_status, 'null') || '/' || owed_minor from app.expense_balances where expense_id = pg_temp.id('exp_a')),
  'null/0', 'a charge that is not reimbursable has no reimbursement status');
select pg_temp.as_platform();

select pg_temp.expense('exp_r', 'carol', 'line_b', 3000, '2027-06-15', null, true);
select pg_temp.as_user('carol');
select is((select reimbursement_status from app.expense_balances where expense_id = pg_temp.id('exp_r')), 'Recorded', 'Recorded while Proposed');
select pg_temp.as_platform();
select pg_temp.approve('exp_r');
select pg_temp.expense('cr_r', 'bob', 'line_b', 1000, '2027-06-16', null, false, 'exp_r');
select pg_temp.approve('cr_r', 'alice');
select pg_temp.as_user('carol');
select is((select reimbursement_status || '/' || owed_minor from app.expense_balances where expense_id = pg_temp.id('exp_r')),
  'Owed/2000', 'Owed once approved, net of its approved credit');
select pg_temp.as_platform();
-- Credited to net zero: nothing can be paid, so it does not read as Owed.
select pg_temp.expense('exp_z', 'carol', 'line_b', 2000, '2027-06-15', null, true);
select pg_temp.approve('exp_z');
select pg_temp.expense('cr_z', 'bob', 'line_b', 2000, '2027-06-16', null, false, 'exp_z');
select pg_temp.approve('cr_z', 'alice');
select pg_temp.as_user('carol');
select is((select reimbursement_status || '/' || owed_minor || '/' || net_minor from app.expense_balances where expense_id = pg_temp.id('exp_z')),
  'Not owed/0/0', 'an Approved reimbursable charge credited to net zero is Not owed');
select pg_temp.as_platform();

-- A field crew member reads their own expense, not finance's credits on it: the balance is withheld, never partial.
select pg_temp.expense('exp_f', 'frank', 'line_a', 2000, '2027-06-17');
select pg_temp.approve('exp_f');
select pg_temp.expense('cr_f', 'carol', 'line_a', 500, '2027-06-18', null, false, 'exp_f');
select pg_temp.approve('cr_f');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.expense_balances where expense_id = pg_temp.id('cr_f')), 0, 'the field person cannot read finance''s credit');
select is((select is_balance_withheld::text || '/' || coalesce(credited_minor::text, 'null') || '/' || coalesce(net_minor::text, 'null')
  from app.expense_balances where expense_id = pg_temp.id('exp_f')), 'true/null/null', 'so their balance is withheld rather than partial');
select pg_temp.as_platform();

-- Events: a credit approval emits expense.approved like a charge's (payloads unchanged in B12, ADR 0151 item 1).
select is((select count(*)::int from app.domain_events where event_type = 'expense.approved' and subject_id = pg_temp.id('cr_a')), 1,
  'approving a credit emits expense.approved');

select * from finish();
rollback;
