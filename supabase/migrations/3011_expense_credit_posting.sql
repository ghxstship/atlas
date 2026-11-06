-- 3011_expense_credit_posting.sql
-- B12 (RRR-236, gap G-223; ADR 0151 item 1). A credit posts as the reversal of its original, and Actual nets it.
--   * app.approve_expense (1611) keeps its eligibility for a credit: finance.expense.approve on the project, the
--     credit's own submitter refused (sod_expense_submitter), Proposed only, and spend authority with the
--     sod_document_creator option and approval workflows (2281, 1030). A charge posts exactly as 1611 posts it. A credit
--     debits Accounts Payable (2000) and credits the account and every dimension of its original's posted debit line,
--     so it reverses what the original actually posted even when the GL defaults have changed since. It is dated the
--     credit's incurred_on. An original with no posted entry is refused (expense_credit_original_unposted).
--   * Approving a credit emits expense.approved, and inserting one emits expense.submitted, each with the positive
--     amount (0321): event payloads are unchanged in B12 and a webhook subscriber cannot yet tell a credit from a charge
--     (ADR 0151 item 1).
--   * app.budget_line_amounts (1611) keeps its columns in order; actual_minor is now approved and paid charges less
--     approved and paid credits. app.budget_totals, app.budget_revised_totals and app.budget_line_facts read it, so the
--     budget grid, budget versus actual and the final cost report net credits with no further change.
--   * app.expense_balances gives each live expense its credited, pending, net, creditable and owed amounts and its
--     reimbursement status. It is security invoker, and a reader without finance.expense.read on the project (a field
--     crew member reading their own expense) cannot read the credits finance recorded, so the figures that depend on
--     them are withheld rather than shown partial (is_balance_withheld, the 2810 silence rule).

-- 1. Approval (from 1611) ---------------------------------------------------------------------------------------------

create or replace function app.approve_expense(p_expense_id uuid, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_expense app.expenses;
  v_line app.budget_lines;
  v_project uuid;
  v_account text;
  v_cost_center uuid;
  v_approved boolean;
  v_entry uuid;
  v_debit record;
  v_credit record;
begin
  select * into v_expense from app.expenses e where e.id = p_expense_id and e.deleted_at is null for update;
  select * into v_line from app.budget_lines bl where bl.id = v_expense.budget_line_id;
  select b.project_id into v_project from app.budgets b where b.id = v_line.budget_id;
  if v_expense.id is null or not private.can_on_project(v_project, 'finance.expense.approve') then
    raise exception using errcode = '42501', message = 'finance.expense.approve is required on the project';
  end if;
  perform private.assert_separation('sod_expense_submitter', v_person, v_expense.submitter_person_id);
  if v_expense.expense_state <> 'Proposed' then
    perform private.refuse('expense_state_conflict', 'Only a Proposed expense can be approved.');
  end if;
  if v_expense.credit_of_expense_id is null then
    v_account := private.gl_account_for_line(v_line.urid, 'Expense', v_line.element_id, v_expense.counterparty_id);
    if v_account is null then
      perform private.refuse('gl_account_unresolved', format('No expense account resolves for %s.', v_line.urid));
    end if;
    v_cost_center := v_line.cost_center_id;
  else
    -- The original's latest posted entry: line 1 is its debit, line 2 its Accounts Payable credit (1611).
    select jl.account_code, jl.cost_center_id, jl.urid, jl.counterparty_id into v_debit
    from app.journal_entries je
    join app.journal_lines jl on jl.journal_entry_id = je.id and jl.line_number = 1
    where je.source_table = 'expenses' and je.source_id = v_expense.credit_of_expense_id and je.journal_state = 'Posted'
    order by je.entry_date desc, je.id desc
    limit 1;
    if not found then
      perform private.refuse('expense_credit_original_unposted', 'The expense this credit is against has no posted entry to reverse.');
    end if;
    select jl.cost_center_id, jl.urid, jl.counterparty_id into v_credit
    from app.journal_entries je
    join app.journal_lines jl on jl.journal_entry_id = je.id and jl.line_number = 2
    where je.source_table = 'expenses' and je.source_id = v_expense.credit_of_expense_id and je.journal_state = 'Posted'
    order by je.entry_date desc, je.id desc
    limit 1;
    v_account := v_debit.account_code;
    v_cost_center := v_debit.cost_center_id;
  end if;
  v_approved := private.approve_under_spend_authority(v_expense.org_id, 'Expense', v_expense.id, v_expense.amount_minor,
    v_expense.currency_code, v_account, v_cost_center);
  if not v_approved then
    return false;
  end if;
  perform private.transition_lifecycle('expense', 'app.expenses', 'expense_state', 'app.expense_state_transitions',
    'expense_id', v_expense.id, 'Proposed', 'Approved', p_reason);

  perform private.begin_trusted_operation('system_journal');
  insert into app.journal_entries (accounting_period_id, project_id, entry_date, memo, source_table, source_id)
  values (private.postable_period(v_expense.org_id, v_expense.incurred_on), v_project, v_expense.incurred_on,
          case when v_expense.credit_of_expense_id is null then v_expense.description
               else left('Credit: ' || v_expense.description, 500) end,
          'expenses', v_expense.id)
  returning id into v_entry;
  perform private.end_trusted_operation('system_journal');
  if v_expense.credit_of_expense_id is null then
    insert into app.journal_lines (journal_entry_id, line_number, account_code, cost_center_id, urid, counterparty_id,
      description, debit_minor, credit_minor, currency_code) values
      (v_entry, 1, v_account, v_line.cost_center_id, v_line.urid, v_expense.counterparty_id, v_expense.description,
       v_expense.amount_minor, 0, v_expense.currency_code),
      (v_entry, 2, '2000', v_line.cost_center_id, v_line.urid, v_expense.counterparty_id, v_expense.description,
       0, v_expense.amount_minor, v_expense.currency_code);
    perform private.post_journal(v_entry, 'Expense approved.');
  else
    insert into app.journal_lines (journal_entry_id, line_number, account_code, cost_center_id, urid, counterparty_id,
      description, debit_minor, credit_minor, currency_code) values
      (v_entry, 1, '2000', v_credit.cost_center_id, v_credit.urid, v_credit.counterparty_id, v_expense.description,
       v_expense.amount_minor, 0, v_expense.currency_code),
      (v_entry, 2, v_debit.account_code, v_debit.cost_center_id, v_debit.urid, v_debit.counterparty_id, v_expense.description,
       0, v_expense.amount_minor, v_expense.currency_code);
    perform private.post_journal(v_entry, 'Expense credit approved.');
  end if;
  return true;
end;
$$;

comment on function app.approve_expense(uuid, text) is 'Approves a submitted expense: needs finance.expense.approve on the project, refuses the submitter (sod_expense_submitter), applies spend authority (two approvers above the dual threshold), then moves it to Approved and posts it in the period covering incurred_on (invariant 13). A charge posts to the line''s expense account (private.gl_account_for_line: the item''s explicit GL default, else the class expense account, else the counterparty type''s default) against Accounts Payable. A credit (3011) posts the reversal of its original: Accounts Payable debited with the cost center, URID and counterparty of the original''s Accounts Payable line, and the account, cost center, URID and counterparty of the original''s posted debit line credited; an original without a posted entry is refused (expense_credit_original_unposted). Returns true once fully approved.';
revoke all on function app.approve_expense(uuid, text) from public, anon;
grant execute on function app.approve_expense(uuid, text) to authenticated, service_role;

-- 2. Actual nets credits (from 1611) ----------------------------------------------------------------------------------

create or replace view app.budget_line_amounts with (security_invoker = true) as
select bl.id as budget_line_id, bl.budget_id, bl.line_type, bl.urid,
  private.gl_account_for_line(bl.urid, 'Expense', bl.element_id) as account_code,
  private.extended_minor(bl.quantity, bl.unit_price_minor) as extended_minor,
  (bl.unit_price_minor is null) as is_unpriced,
  coalesce((select sum(d.amount_minor) from app.contingency_draws d where d.to_budget_line_id = bl.id and d.deleted_at is null), 0) as drawn_in_minor,
  coalesce((select sum(d.amount_minor) from app.contingency_draws d where d.from_budget_line_id = bl.id and d.deleted_at is null), 0) as drawn_out_minor,
  coalesce((select sum(case when e.credit_of_expense_id is null then e.amount_minor else -e.amount_minor end)
            from app.expenses e where e.budget_line_id = bl.id and e.deleted_at is null
            and e.expense_state in ('Approved', 'Paid')), 0) as actual_minor
from app.budget_lines bl
where bl.deleted_at is null;

comment on view app.budget_line_amounts is 'Budget line amounts, derived: extended amount (NULL when unpriced, never zero), contingency moved in and out, the GL account (the item''s explicit default, else by class: decision D13 as owner decision 39 reads it) and approved spend net of approved credits.';
comment on column app.budget_line_amounts.actual_minor is 'Approved and paid expenses posted to the line, net of approved and paid credits (3011). Proposed, Rejected and Canceled credits never count.';

-- 3. Balances per expense ---------------------------------------------------------------------------------------------

create view app.expense_balances with (security_invoker = true) as
select e.id as expense_id, e.budget_line_id,
  (e.credit_of_expense_id is not null) as is_credit,
  w.is_withheld as is_balance_withheld,
  case when not w.is_withheld then c.credited_minor end as credited_minor,
  case when not w.is_withheld then c.pending_credit_minor end as pending_credit_minor,
  case when e.credit_of_expense_id is not null then -e.amount_minor
       when not w.is_withheld then e.amount_minor - c.credited_minor end as net_minor,
  case when e.credit_of_expense_id is null and not w.is_withheld
       then e.amount_minor - c.credited_minor - c.pending_credit_minor end as creditable_minor,
  case when not e.is_reimbursable then null
       when e.expense_state = 'Proposed' then 'Recorded'
       when e.expense_state = 'Approved' and not w.is_withheld and e.amount_minor - c.credited_minor <= 0 then 'Not owed'
       when e.expense_state = 'Approved' then 'Owed'
       when e.expense_state = 'Paid' then 'Paid'
       else 'Not owed' end as reimbursement_status,
  case when w.is_withheld then null
       when e.is_reimbursable and e.expense_state = 'Approved' then e.amount_minor - c.credited_minor
       else 0 end as owed_minor
from app.expenses e
cross join lateral (
  select e.budget_line_id not in (select private.budget_line_ids_with('finance.expense.read')) as is_withheld
) w
cross join lateral (
  select
    coalesce(sum(x.amount_minor) filter (where x.expense_state in ('Approved', 'Paid')), 0)::bigint as credited_minor,
    coalesce(sum(x.amount_minor) filter (where x.expense_state = 'Proposed'), 0)::bigint as pending_credit_minor
  from app.expenses x
  where x.credit_of_expense_id = e.id and x.deleted_at is null
) c
where e.deleted_at is null;

call private.describe('app.expense_balances', 'One row per live expense the reader can read, with what its credits have taken back and what is owed to a reimbursable expense''s payer (G-223, G-228). Security invoker: the app.expenses read policy applies to the expense and its credits. A reader without finance.expense.read on the project, such as a field crew member reading their own expense, cannot read credits finance recorded, so every figure that depends on them is NULL (is_balance_withheld) rather than partial.', array[
  'expense_id', 'Expense.',
  'budget_line_id', 'Budget line of the expense.',
  'is_credit', 'True when the expense is a credit against another.',
  'is_balance_withheld', 'True when the reader lacks finance.expense.read on the project, so the credit figures are NULL rather than partial.',
  'credited_minor', 'Approved and paid credits against the expense; zero for a credit; NULL when withheld.',
  'pending_credit_minor', 'Proposed credits against the expense; zero for a credit; NULL when withheld.',
  'net_minor', 'The amount less approved and paid credits for a charge; the negative amount for a credit; NULL for a charge when withheld.',
  'creditable_minor', 'What a new credit may still take: the amount less approved, paid and proposed credits. NULL for a credit and when withheld.',
  'reimbursement_status', 'For a reimbursable expense: Recorded while Proposed, Owed while Approved, Paid once reimbursed, Not owed when Rejected or Canceled or when credits have taken an Approved charge to net zero (a reader whose figures are withheld sees Owed, since they cannot read the credits). NULL when not reimbursable.',
  'owed_minor', 'The net owed to the payer while the reimbursable expense is Owed, else zero; NULL when withheld.'
]);

revoke all on app.expense_balances from public, anon;
grant select on app.expense_balances to authenticated, service_role;
-- 1650 grants the backup login SELECT on every new relation; pg_dump never reads a view's rows.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'xos_backup') then
    revoke select on app.expense_balances from xos_backup;
  end if;
end;
$$;
