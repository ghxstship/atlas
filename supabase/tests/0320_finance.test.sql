-- pgTAP: finance (Section 7.4 Finance). Same-tenant allow, cross-tenant deny, anon deny, role bands,
-- invariants 10 (closed production), 11 (NULL price, unpriced change orders), 12 (one budget line per
-- expense), 13 (closed periods, Audited only through Closed), 16 (each payment counted once), 18
-- (approver never the requester), spend authority (Section 8.1), separation of duties (Section 8.2),
-- and every finance state machine.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(112);

-- World ----------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.cost_centers (org_id, code, name, kind) values (pg_temp.id('org_a'), 'CC-VENUE', 'Venue Operations', 'Standing') returning id) insert into world select 'cc_venue', id from x;
with x as (insert into app.accounting_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-01', '2027-06-30') returning id) insert into world select 'per_jun', id from x;
with x as (insert into app.accounting_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-07-01', '2027-07-31') returning id) insert into world select 'per_jul', id from x;
with x as (insert into app.budgets (project_id, name, currency_code, is_baseline) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD', true) returning id) insert into world select 'bud_a', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, cost_center_id, quantity, unit_price_minor, xyz, xyz_basis, grade_code)
  values (pg_temp.id('bud_a'), 1, 'Stage deck rental.', '0000.01.01', pg_temp.id('cc_venue'), 2, 15000, 'X', 'Category', 'base') returning id) insert into world select 'line_stage', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, xyz, xyz_basis)
  values (pg_temp.id('bud_a'), 2, 'Sound package.', '0000.01.01', 1, 'X', 'Declared') returning id) insert into world select 'line_sound', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, line_type, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_a'), 3, 'Contingency.', '0000.01.01', 'Contingency', 1, 20000, 'Y', 'Declared') returning id) insert into world select 'line_cont', id from x;
select lives_ok($$insert into world values ('cp_client', app.create_counterparty((select id from world where key = 'org_a'), 'Lakeshore Brands', null))$$, 'a Manager records a client');
select pg_temp.as_user('alice');
select lives_ok($$insert into world values ('cp_vendor', app.create_counterparty((select id from world where key = 'org_a'), 'Pier Rigging Co', 'Rigging Engineering'))$$, 'an owner records a vendor');
select pg_temp.as_platform();

-- Budgets: NULL-aware totals (invariant 11) ---------------------------------------------------------------
select is((select total_minor from app.budget_totals where budget_id = pg_temp.id('bud_a')), null::bigint, 'inv_11_null_price: a budget with an unpriced line has no total');
select is((select unpriced_count::int from app.budget_totals where budget_id = pg_temp.id('bud_a')), 1, 'inv_11_null_price: and reports one unpriced line');
select is((select priced_total_minor from app.budget_totals where budget_id = pg_temp.id('bud_a')), 50000::bigint, 'the priced subtotal sits beside it');
select is((select extended_minor from app.budget_line_amounts where budget_line_id = pg_temp.id('line_sound')), null::bigint, 'inv_11_null_price: an unpriced line extends to NULL, never zero');
select is((select account_code from app.budget_line_amounts where budget_line_id = pg_temp.id('line_stage')), '5000', 'the GL account is derived from the URID class (decision D13)');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.budget_lines (budget_id, line_number, description, urid, xyz, xyz_basis) values ((select id from world where key = 'bud_a'), 9, 'Bad.', '9999.99.99', 'X', 'Declared')$$,
  'XR001', null, 'dimension 2 must be a canon URID');
select lives_ok($$update app.budget_lines set unit_price_minor = 12000 where id = (select id from world where key = 'line_sound')$$, 'pricing the line');
select is((select total_minor from app.budget_totals where budget_id = pg_temp.id('bud_a')), 62000::bigint, 'the total appears once every line is priced');
select pg_temp.as_platform();

-- RLS ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::int from app.budgets), 1, 'a Member reads the budget of their project');
select throws_ok($$insert into app.budgets (project_id, name, currency_code) values ((select id from world where key = 'prj_a'), 'Shadow', 'USD')$$, '42501', null, 'a Member cannot write budgets');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.budgets), 0, 'a Viewer in no project reads no budgets (invariant 2)');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.budget_lines), 0, 'another org reads no budget lines');
select is((select count(*)::int from app.accounting_periods where org_id = pg_temp.id('org_a')), 0, 'nor accounting periods');
select pg_temp.as_anon();
select throws_ok('select 1 from app.expenses', '42501', null, 'anon cannot read expenses');
select throws_ok('select 1 from app.posting_lines', '42501', null, 'anon cannot read the posting lines');
select pg_temp.as_user('xavier');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_b'), 'Pier Nights Budget', 'USD') returning id) insert into world select 'bud_b', id from x;
select throws_ok($$insert into app.budget_lines (budget_id, line_number, description, urid, cost_center_id, xyz, xyz_basis) values ((select id from world where key = 'bud_b'), 1, 'Cross.', '0000.01.01', (select id from world where key = 'cc_venue'), 'X', 'Declared')$$,
  'XR001', null, 'a budget line cannot use another org''s cost center');
select pg_temp.as_platform();

-- Spend authority (Section 8.1) ------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values ((select id from world where key = 'org_a'), pg_temp.system_role('admin'), 'Expense', 'USD', 1000000)$$,
  'XR001', null, 'a person cannot set a limit that applies to themselves (sod_self_grant)');
select lives_ok($$insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor, dual_approval_above_minor) values ((select id from world where key = 'org_a'), pg_temp.system_role('owner'), 'Expense', 'USD', 1000000, 30000)$$,
  'an Admin sets the Owner expense limit');
select pg_temp.as_user('alice');
select lives_ok($$insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor, dual_approval_above_minor) values ((select id from world where key = 'org_a'), pg_temp.system_role('admin'), 'Expense', 'USD', 1000000, 30000)$$,
  'the Owner sets the Admin expense limit');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values ((select id from world where key = 'org_a'), pg_temp.system_role('member'), 'Expense', 'USD', 100)$$,
  '42501', null, 'a Manager cannot set spend authority');
select pg_temp.as_platform();

-- Expenses (invariants 12, 13, 18 and SoD) -----------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, counterparty_id)
  values (pg_temp.id('line_stage'), 'Deck rental deposit.', '2027-06-10', 40000, 'USD', pg_temp.id('cp_vendor')) returning id) insert into world select 'exp1', id from x;
select is((select submitter_person_id from app.expenses where id = pg_temp.id('exp1')), pg_temp.id('carol'), 'the submitter is the session person');
select throws_ok($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code) values ((select id from world where key = 'line_stage'), 'Euro.', '2027-06-10', 100, 'EUR')$$,
  'XR001', null, 'an expense is in its budget currency');
select throws_ok($$update app.expenses set budget_line_id = (select id from world where key = 'line_sound') where id = (select id from world where key = 'exp1')$$,
  'XR001', 'expense_budget_line_immutable: An expense posts to exactly one budget line, which never changes.', 'inv_12_expense_one_line: an expense keeps its one budget line (invariant 12)');
select throws_ok($$insert into app.expenses (description, incurred_on, amount_minor, currency_code) values ('Nowhere.', '2027-06-10', 100, 'USD')$$, '23502', null, 'an expense needs a budget line');
select throws_ok($$select app.approve_expense((select id from world where key = 'exp1'), 'Self.')$$,
  'XR001', 'sod_expense_submitter: The submitter of an expense cannot approve it.', 'the submitter cannot approve their expense');
select throws_ok($$update app.expenses set expense_state = 'Approved' where id = (select id from world where key = 'exp1')$$, 'XR001', null, 'the expense state changes only through its RPCs');
select pg_temp.as_user('dave');
select throws_ok($$select app.approve_expense((select id from world where key = 'exp1'), 'Member.')$$, '42501', null, 'a Member cannot approve expenses');
select pg_temp.as_user('alice');
select is(app.approve_expense(pg_temp.id('exp1'), 'Looks right.'), false, 'above the dual threshold one approval is not enough');
select throws_ok($$select app.approve_expense((select id from world where key = 'exp1'), 'Again.')$$,
  'XR001', null, 'the same approver cannot approve twice');
select pg_temp.as_user('bob');
select is(app.approve_expense(pg_temp.id('exp1'), 'Second approval.'), true, 'a second distinct approver completes the approval');
select pg_temp.as_platform();
select is((select expense_state::text from app.expenses where id = pg_temp.id('exp1')), 'Approved', 'the expense is Approved');
select is((select count(*)::int from app.posting_lines where external_ref = pg_temp.id('exp1')), 2, 'approval posted two lines');
select is((select sum(amount_minor)::bigint from app.posting_lines where external_ref = pg_temp.id('exp1')), 0::bigint, 'the posting balances');
select is((select amount_minor from app.posting_lines where external_ref = pg_temp.id('exp1') and account_code = '5000'), 40000::bigint, 'the class expense account is debited');
select is((select cost_center_id from app.posting_lines where external_ref = pg_temp.id('exp1') and account_code = '2000'), 'CC-VENUE', 'dimension 1 rides on the posting line');
select is((select actual_minor from app.budget_totals where budget_id = pg_temp.id('bud_a')), 40000::bigint, 'the budget actual includes the approved expense');
select is((select count(*)::int from app.domain_events where event_type = 'expense.approved' and subject_id = pg_temp.id('exp1')), 1, 'expense.approved was emitted');
select pg_temp.as_user('carol');
select throws_ok($$update app.expenses set amount_minor = 1 where id = (select id from world where key = 'exp1')$$, 'XR001', null, 'an approved expense cannot change its amount');
with x as (insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code) values (pg_temp.id('line_stage'), 'Huge.', '2027-06-11', 2000000, 'USD') returning id) insert into world select 'exp_big', id from x;
select pg_temp.as_user('bob');
select throws_ok($$select app.approve_expense((select id from world where key = 'exp_big'), 'Too big.')$$,
  'XR001', 'spend_authority_exceeded: This Expense exceeds the approver''s limit; route it to the next approver in the policy.', 'an amount above the limit is refused');
select pg_temp.as_user('xavier');
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis) values (pg_temp.id('bud_b'), 1, 'Dock.', '0000.01.01', 1, 100, 'X', 'Declared') returning id) insert into world select 'line_b', id from x;
with x as (insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code) values (pg_temp.id('line_b'), 'Dock fee.', '2027-06-10', 100, 'USD') returning id) insert into world select 'exp_b', id from x;
select pg_temp.as_platform();
select pg_temp.as_user('carol');
select throws_ok($$select app.approve_expense((select id from world where key = 'exp_b'), 'Cross.')$$, '42501', null, 'a Northwind Manager cannot approve a Harbor Lights expense');
select pg_temp.as_platform();

-- Expense state machine -------------------------------------------------------------------------------------------
select is((select string_agg(from_state || '>' || to_state, ' ' order by from_state, to_state) from app.lifecycle_transition_rules where lifecycle = 'expense'),
  'Approved>Paid Proposed>Approved Proposed>Canceled Proposed>Rejected Rejected>Proposed', 'the expense lifecycle moves');
select pg_temp.as_user('alice');
select lives_ok($$select app.reject_expense((select id from world where key = 'exp_big'), 'Over limit.')$$, 'Proposed to Rejected');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_expense((select id from world where key = 'exp_big'), 'Rejected', 'Proposed', 'Resubmitted.')$$, 'the submitter resubmits');
select lives_ok($$select app.transition_expense((select id from world where key = 'exp_big'), 'Proposed', 'Canceled', 'Withdrawn.')$$, 'the submitter cancels');
select throws_ok($$select app.transition_expense((select id from world where key = 'exp_big'), 'Canceled', 'Proposed', 'Revive.')$$, 'XR001', 'expense_transition_not_allowed: A expense cannot move from Canceled to Proposed.', 'Canceled is terminal');
select throws_ok($$select app.transition_expense((select id from world where key = 'exp1'), 'Approved', 'Rejected', 'No.')$$,
  'XR001', 'expense_use_approval_rpc: Approve or reject an expense through app.approve_expense or app.reject_expense.', 'rejection only through its RPC (expense_use_approval_rpc)');
-- Every move to Rejected through transition_expense meets that guard, and app.reject_expense only moves a Proposed
-- expense, so the Approved to Rejected rule is asserted in the transition engine every RPC calls (A54-003).
select pg_temp.as_platform();
select throws_ok($$select private.transition_lifecycle('expense', 'app.expenses', 'expense_state', 'app.expense_state_transitions', 'expense_id', (select id from world where key = 'exp1'), 'Approved', 'Rejected', 'No.')$$,
  'XR001', 'expense_transition_not_allowed: A expense cannot move from Approved to Rejected.', 'an Approved expense cannot be rejected');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_expense((select id from world where key = 'exp1'), 'Approved', 'Paid', 'Wired.')$$, 'Approved to Paid');
select pg_temp.as_platform();

-- Journal and periods (invariant 13, SoD) ----------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.journal_entries (accounting_period_id, entry_date, memo) values (pg_temp.id('per_jul'), '2027-07-02', 'Accrue stage storage.') returning id) insert into world select 'je1', id from x;
insert into app.journal_lines (journal_entry_id, line_number, account_code, description, debit_minor, currency_code) values (pg_temp.id('je1'), 1, '5000', 'Storage accrual.', 5000, 'USD');
select throws_ok($$insert into app.journal_lines (journal_entry_id, line_number, account_code, description, debit_minor, credit_minor, currency_code) values ((select id from world where key = 'je1'), 9, '2100', 'Both sides.', 5, 5, 'USD')$$,
  '23514', null, 'a journal line is a debit or a credit, not both');
select pg_temp.as_user('alice');
select throws_ok($$select app.post_journal_entry((select id from world where key = 'je1'), 'Post.')$$, 'XR001', null, 'an unbalanced entry does not post');
select pg_temp.as_user('carol');
insert into app.journal_lines (journal_entry_id, line_number, account_code, description, credit_minor, currency_code) values (pg_temp.id('je1'), 2, '2100', 'Storage accrual.', 5000, 'USD');
select throws_ok($$select app.post_journal_entry((select id from world where key = 'je1'), 'Post.')$$,
  'XR001', 'sod_journal_preparer: The preparer of a journal entry cannot post it.', 'the preparer cannot post');
select pg_temp.as_user('alice');
select lives_ok($$select app.post_journal_entry((select id from world where key = 'je1'), 'Reviewed.')$$, 'another person posts the balanced entry');
select throws_ok($$select app.cancel_journal_entry((select id from world where key = 'je1'), 'Too late.')$$,
  'XR001', 'journal_state_conflict: The journal is not in the expected state Proposed.', 'a posted journal entry cannot be canceled');
select is((select posted_by from app.journal_entries where id = pg_temp.id('je1')), pg_temp.id('alice'), 'the poster is recorded');
select throws_ok($$update app.journal_lines set debit_minor = 6000 where journal_entry_id = (select id from world where key = 'je1') and line_number = 1$$,
  'XR001', null, 'a posted entry''s lines never change');
select pg_temp.as_platform();

select is((select string_agg(from_state || '>' || to_state, ' ' order by from_state, to_state) from app.lifecycle_transition_rules where lifecycle = 'accounting_period'),
  'Audited>Archived Closed>Audited Closing>Closed Closing>In Period In Period>Closing Open>In Period', 'the period lifecycle moves');
select pg_temp.as_user('carol');
select throws_ok($$select app.transition_accounting_period((select id from world where key = 'per_jul'), 'Open', 'Audited', 'Skip.')$$,
  'XR001', 'accounting_period_transition_not_allowed: A accounting period cannot move from Open to Audited.', 'inv_13_period_postings: an Open period cannot become Audited without Closed (invariant 13)');
select throws_ok($$select app.transition_accounting_period((select id from world where key = 'per_jun'), 'Open', 'Closed', 'Skip.')$$, 'XR001', 'accounting_period_transition_not_allowed: A accounting period cannot move from Open to Closed.', 'an Open period cannot jump to Closed');
select lives_ok($$select app.transition_accounting_period((select id from world where key = 'per_jun'), 'Open', 'In Period', 'June starts.')$$, 'Open to In Period');
select lives_ok($$select app.transition_accounting_period((select id from world where key = 'per_jun'), 'In Period', 'Closing', 'Month end.')$$, 'In Period to Closing');
select lives_ok($$select app.transition_accounting_period((select id from world where key = 'per_jun'), 'Closing', 'In Period', 'Late invoice.')$$, 'Closing back to In Period');
select lives_ok($$select app.transition_accounting_period((select id from world where key = 'per_jun'), 'In Period', 'Closing', 'Month end.')$$, 'In Period to Closing again');
select lives_ok($$select app.transition_accounting_period((select id from world where key = 'per_jun'), 'Closing', 'Closed', 'Books closed.')$$, 'Closing to Closed');
select throws_ok($$select app.transition_accounting_period((select id from world where key = 'per_jun'), 'Closed', 'Open', 'Reopen.')$$, 'XR001', 'accounting_period_transition_not_allowed: A accounting period cannot move from Closed to Open.', 'a Closed period cannot reopen');
with x as (insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code) values (pg_temp.id('line_stage'), 'Late receipt.', '2027-06-20', 1000, 'USD') returning id) insert into world select 'exp_late', id from x;
select pg_temp.as_user('bob');
select throws_ok($$select app.approve_expense((select id from world where key = 'exp_late'), 'Late.')$$,
  'XR001', 'period_closed: The period covering 2027-06-20 is Closed and refuses postings.', 'inv_13_period_postings: a closed period refuses the posting of an approved expense (invariant 13)');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.journal_entries (accounting_period_id, entry_date, memo) values ((select id from world where key = 'per_jun'), '2027-06-30', 'Backdated.')$$,
  'XR001', null, 'no journal entry is prepared in a closed period');
select lives_ok($$select app.transition_accounting_period((select id from world where key = 'per_jun'), 'Closed', 'Audited', 'Audit signed.')$$, 'Closed to Audited');
select lives_ok($$select app.transition_accounting_period((select id from world where key = 'per_jun'), 'Audited', 'Archived', 'Archived.')$$, 'Audited to Archived');
select throws_ok($$insert into app.accounting_periods (org_id, starts_on, ends_on) values ((select id from world where key = 'org_a'), '2027-07-15', '2027-08-15')$$,
  'XR001', null, 'periods never overlap');
select pg_temp.as_user('dave');
select throws_ok($$select app.transition_accounting_period((select id from world where key = 'per_jul'), 'Open', 'In Period', 'x')$$, '42501', null, 'a Member cannot manage periods');
select pg_temp.as_platform();

-- Contingency ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$insert into app.contingency_draws (from_budget_line_id, to_budget_line_id, amount_minor, reason) values ((select id from world where key = 'line_cont'), (select id from world where key = 'line_sound'), 15000, 'Extra monitors.')$$, 'a contingency draw');
select throws_ok($$insert into app.contingency_draws (from_budget_line_id, to_budget_line_id, amount_minor, reason) values ((select id from world where key = 'line_cont'), (select id from world where key = 'line_sound'), 10000, 'More.')$$,
  'XR001', 'contingency_exhausted: The draw exceeds the contingency remaining.', 'a draw beyond the remaining contingency is refused');
select throws_ok($$insert into app.contingency_draws (from_budget_line_id, to_budget_line_id, amount_minor, reason) values ((select id from world where key = 'line_stage'), (select id from world where key = 'line_sound'), 100, 'Not contingency.')$$,
  'XR001', null, 'draws come from a Contingency line');
select pg_temp.as_platform();

-- Change orders (invariant 11, SoD, spend authority) ------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.change_orders (project_id, budget_id, title, order_type_enum_id, reason) values (pg_temp.id('prj_a'), pg_temp.id('bud_a'), 'Add a second stage', 'ENM-092', 'Client asked for a second stage.') returning id) insert into world select 'co1', id from x;
insert into app.change_order_lines (change_order_id, description, urid, quantity) values (pg_temp.id('co1'), 'Second stage deck.', '0000.01.01', 1);
select throws_ok($$insert into app.change_order_lines (change_order_id, description, urid, unit_price_minor) values ((select id from world where key = 'co1'), 'Free labor.', '0000.01.01', 0)$$,
  '23514', null, 'inv_11_null_price: a zero price without a no-cost declaration is refused (invariant 11)');
select lives_ok($$insert into app.change_order_lines (change_order_id, description, urid, unit_price_minor, is_no_cost) values ((select id from world where key = 'co1'), 'Waived setup.', '0000.01.01', 0, true)$$, 'a declared no-cost line is accepted');
select is((select total_minor from app.change_order_totals where change_order_id = pg_temp.id('co1')), null::bigint, 'inv_11_null_price: an unpriced change order totals NULL, never zero');
select is((select unpriced_count::int from app.change_order_totals where change_order_id = pg_temp.id('co1')), 1, 'with its unpriced count');
select throws_ok($$select app.price_change_order((select id from world where key = 'co1'), 'Priced.')$$, 'XR001', null, 'an unpriced change order cannot be marked priced');
update app.change_order_lines set unit_price_minor = 25000 where change_order_id = pg_temp.id('co1') and description = 'Second stage deck.';
select lives_ok($$select app.price_change_order((select id from world where key = 'co1'), 'Priced.')$$, 'Proposed to Priced');
select throws_ok($$update app.change_order_lines set unit_price_minor = 1 where change_order_id = (select id from world where key = 'co1') and description = 'Second stage deck.'$$,
  'XR001', null, 'priced lines are locked');
select throws_ok($$select app.approve_change_order((select id from world where key = 'co1'), 'Self.')$$,
  'XR001', 'sod_change_order_requester: The requester of a change order cannot price and approve it alone.', 'the requester cannot approve their change order');
select pg_temp.as_user('alice');
select throws_ok($$select app.approve_change_order((select id from world where key = 'co1'), 'No limit.')$$,
  'XR001', 'spend_authority_missing: No spend authority lets this person approve a Change Order in USD.', 'no applicable spend authority is an absent claim and refuses');
select pg_temp.as_user('bob');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values (pg_temp.id('org_a'), pg_temp.system_role('owner'), 'Change Order', 'USD', 1000000);
select pg_temp.as_user('alice');
select is(app.approve_change_order(pg_temp.id('co1'), 'Approved.'), true, 'an eligible approver within limit approves');
select is((select change_order_state::text from app.change_orders where id = pg_temp.id('co1')), 'Approved', 'the change order is Approved');
select throws_ok($$select app.transition_change_order((select id from world where key = 'co1'), 'Approved', 'Proposed', 'Reopen.')$$,
  'XR001', 'change_order_transition_not_allowed: A change order cannot move from Approved to Proposed.', 'an Approved change order does not return to Proposed');
select is((select count(*)::int from app.change_order_state_transitions where change_order_id = pg_temp.id('co1')), 3, 'the change order ledger holds creation, Priced and Approved');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'change_order'), 7, 'the change order lifecycle declares seven moves');
select pg_temp.as_platform();

-- Invoices and payments (invariant 16) --------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code, issued_on) values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_client'), 'NWL-INV-001', 'USD', '2027-07-10') returning id) insert into world select 'inv1', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, quantity, urid) values (pg_temp.id('inv1'), 1, 'Production fee.', 1, '0000.01.01');
select throws_ok($$select app.issue_invoice((select id from world where key = 'inv1'), 'Send.')$$,
  'XR001', 'invoice_unpriced: Every line of an invoice needs a price before it is issued.', 'an invoice with an unpriced line cannot be issued');
update app.invoice_lines set unit_price_minor = 25000 where invoice_id = pg_temp.id('inv1');
select lives_ok($$select app.issue_invoice((select id from world where key = 'inv1'), 'Send.')$$, 'Proposed to Issued');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'invoice.issued' and subject_id = pg_temp.id('inv1')), 1, 'invoice.issued was emitted');
select pg_temp.as_user('carol');
select throws_ok($$update app.invoice_lines set unit_price_minor = 1 where invoice_id = (select id from world where key = 'inv1')$$, 'XR001', null, 'issued invoice lines are locked');
select throws_ok($$select app.transition_invoice((select id from world where key = 'inv1'), 'Issued', 'Proposed', 'Recall.')$$,
  'XR001', 'invoice_transition_not_allowed: A invoice cannot move from Issued to Proposed.', 'an Issued invoice does not return to Proposed');
with x as (insert into app.payments (counterparty_id, direction, amount_minor, currency_code, paid_on) values (pg_temp.id('cp_client'), 'Receivable', 30000, 'USD', '2027-07-05') returning id) insert into world select 'pay1', id from x;
select lives_ok($$insert into app.payment_applications (payment_id, invoice_id, amount_minor) values ((select id from world where key = 'pay1'), (select id from world where key = 'inv1'), 20000)$$, 'a payment is applied to an invoice');
select throws_ok($$insert into app.payment_applications (payment_id, invoice_id, amount_minor) values ((select id from world where key = 'pay1'), (select id from world where key = 'inv1'), 1000)$$,
  '23505', null, 'inv_16_billed_once: a payment applies to an invoice once (invariant 16)');
with x as (insert into app.invoices (project_id, direction, counterparty_id, currency_code, issued_on) values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_client'), 'USD', '2027-07-12') returning id) insert into world select 'inv2', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor, urid) values (pg_temp.id('inv2'), 1, 'Overtime.', 1, 50000, '0000.01.01');
select app.issue_invoice(pg_temp.id('inv2'), 'Send.');
select throws_ok($$insert into app.payment_applications (payment_id, invoice_id, amount_minor) values ((select id from world where key = 'pay1'), (select id from world where key = 'inv2'), 15000)$$,
  'XR001', 'payment_overapplied: A payment is never applied beyond its amount.', 'a payment is never applied beyond its amount');
with x as (insert into app.payments (counterparty_id, direction, amount_minor, currency_code, paid_on) values (pg_temp.id('cp_client'), 'Receivable', 90000, 'USD', '2027-07-06') returning id) insert into world select 'pay2', id from x;
select throws_ok($$insert into app.payment_applications (payment_id, invoice_id, amount_minor) values ((select id from world where key = 'pay2'), (select id from world where key = 'inv1'), 6000)$$,
  'XR001', 'invoice_overpaid: An invoice is never paid beyond its total.', 'an invoice is never paid beyond its total');
select lives_ok($$insert into app.payment_applications (payment_id, invoice_id, amount_minor) values ((select id from world where key = 'pay2'), (select id from world where key = 'inv1'), 5000)$$, 'the rest of the invoice is paid by a second payment');
select is((select billed_to_date_minor from app.project_billing where project_id = pg_temp.id('prj_a')), 75000::bigint, 'billed-to-date sums issued receivables');
select is((select paid_to_date_minor from app.project_billing where project_id = pg_temp.id('prj_a')), 25000::bigint, 'inv_16_billed_once: paid-to-date counts each application once (invariant 16)');
select throws_ok($$select app.approve_payment((select id from world where key = 'pay1'), 'Self.')$$,
  'XR001', 'sod_approval_requester: An approval is decided by an eligible approver, never the requester.', 'the recorder cannot approve a payment');
with x as (insert into app.payments (counterparty_id, direction, amount_minor, currency_code, paid_on) values (pg_temp.id('cp_vendor'), 'Payable', 1000, 'USD', '2027-07-06') returning id) insert into world select 'pay_v', id from x;
select pg_temp.as_user('alice');
select throws_ok($$select app.approve_payment((select id from world where key = 'pay_v'), 'Pay.')$$,
  'XR001', 'sod_vendor_payment: A person who creates a vendor or edits its bank details cannot approve payment to it.', 'the person who created the vendor cannot approve payment to it');
select pg_temp.as_user('bob');
select lives_ok($$select app.approve_payment((select id from world where key = 'pay_v'), 'Pay.')$$, 'another eligible person approves the vendor payment');
select pg_temp.as_user('carol');
select throws_ok($$select app.cancel_payment((select id from world where key = 'pay_v'), 'Stop.')$$,
  'XR001', 'payment_state_conflict: The payment is not in the expected state Proposed.', 'an Approved payment cannot be canceled');
select pg_temp.as_user('carol');
with x as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code) values (pg_temp.id('prj_a'), 'Payable', pg_temp.id('cp_vendor'), 'PRC-7781', 'USD') returning id) insert into world select 'inv_p', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, unit_price_minor) values (pg_temp.id('inv_p'), 1, 'Rigging.', 4000);
select throws_ok($$select app.approve_invoice((select id from world where key = 'inv_p'), 'Self.')$$, 'XR001', null, 'the recorder cannot approve a payable invoice');
select pg_temp.as_platform();

-- Tax and FX ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.tax_jurisdictions (org_id, jurisdiction_id, name) values (pg_temp.id('org_a'), 'US-FL', 'Florida Department of Revenue') returning id) insert into world select 'tj', id from x;
insert into app.tax_rates (tax_jurisdiction_id, tax_type, rate_percent, effective_from) values (pg_temp.id('tj'), 'Tax on Sales', 6, '2027-01-01');
select throws_ok($$insert into app.tax_rates (tax_jurisdiction_id, tax_type, rate_percent, effective_from) values ((select id from world where key = 'tj'), 'Tax on Sales', 7, '2027-06-01')$$, 'XR001', null, 'tax rates never overlap');
select throws_ok($$insert into app.tax_rates (tax_jurisdiction_id, tax_type, rate_percent, effective_from) values ((select id from world where key = 'tj'), 'Sales Levy', 7, '2027-06-01')$$, 'XR001', null, 'a tax type comes from canon');
select throws_ok($$insert into app.fx_rates (org_id, base_currency, quote_currency, rate, effective_on, source) values ((select id from world where key = 'org_a'), 'USD', 'EUR', 0, '2027-07-01', 'Bank')$$, '23514', null, 'an FX rate is positive');
select pg_temp.as_platform();

-- Invariant 10: a closed production refuses new spend --------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.transition_production(pg_temp.id('prj_a'), 'Proposed', 'Active', 'Live.');
select app.transition_production(pg_temp.id('prj_a'), 'Active', 'Complete', 'Wrapped.');
select app.transition_production(pg_temp.id('prj_a'), 'Complete', 'Closed', 'Closed.');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code) values ((select id from world where key = 'line_stage'), 'After close.', '2027-07-20', 100, 'USD')$$,
  'XR001', 'production_closed: A closed production refuses new invoices, purchase orders, expenses, time entries and change orders.', 'inv_10_closed_production: a closed production refuses a new expense');
select throws_ok($$insert into app.change_orders (project_id, budget_id, title) values ((select id from world where key = 'prj_a'), (select id from world where key = 'bud_a'), 'Late change')$$,
  'XR001', null, 'inv_10_closed_production: a closed production refuses a new change order');
select throws_ok($$insert into app.invoices (project_id, direction, counterparty_id, currency_code) values ((select id from world where key = 'prj_a'), 'Receivable', (select id from world where key = 'cp_client'), 'USD')$$,
  'XR001', null, 'inv_10_closed_production: a closed production refuses a new invoice');
select pg_temp.as_platform();

select * from finish();
rollback;
