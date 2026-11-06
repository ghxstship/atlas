-- 3010_expense_credit_and_reimbursable_columns.sql
-- B12 (RRR-236, gaps G-223 and G-228; ADR 0151 items 1 and 2). Two facts an expense could not hold:
--   * A credit: a refund or vendor credit against an expense already approved. It is an expense row naming its
--     original (credit_of_expense_id). The amount stays positive (expenses_amount_positive, 0321) and there is no new
--     state: the sign comes from being a credit. A credit sits on its original's budget line, in its currency and
--     with its counterparty, and the live credits of a charge that are not Rejected or Canceled never exceed it.
--     Approval reverses the original's posting (3011) and Actual nets approved credits.
--   * Reimbursable: the submitter paid out of pocket and is owed (decision 76: field crews file from Compass). The
--     money is recorded as moved on app.expense_reimbursements, written only by the 3012 RPCs, never moved by XOS
--     (decision 20, ADR 0029 item 3).
-- private.guard_expense is recreated from its only definition (0321) with every check kept, and adds:
--   * on inserting a credit, and on the three ways a credit comes back into play (its amount edited while Proposed,
--     Rejected to Proposed, restored from Trash), the original is read for update and must be a live Approved or Paid
--     charge of the org on the same line, not a reimbursable charge already paid, with room for the amount;
--   * inserting a row needs finance.expense.write (the 0321 policy), and a credit also needs finance.expense.approve on
--     the project or finance.payment.write in the org (a field crew member, who holds write only, could otherwise use up
--     a charge's creditable amount);
--   * a charge with live credits is not trashed, an Approved or Paid credit is not trashed (its reversal stays Posted,
--     so Actual and the creditable amount would spring back: expense_credit_posted), and a reimbursed expense keeps its
--     description and counterparty and is not trashed (3017 adds the engagement);
--   * the credit link and a credit's counterparty never change, the reimbursable flag is fixed after Proposed, and the
--     reimbursement link changes only inside the reimbursement RPCs (private.in_trusted_operation('expense_reimbursement')).

-- 1. Reimbursements ---------------------------------------------------------------------------------------------------
-- Org-rooted like app.fx_rates (0321). The amount column is paid_minor, not amount_minor, so app.expenses.amount_minor
-- does not restate it through reimbursement_id (1282).

create table app.expense_reimbursements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  payee_person_id uuid not null references app.people (id),
  currency_code char(3) not null references private.currencies (currency_code),
  paid_minor bigint not null,
  paid_on date not null,
  reference_identifier text,
  voided_at timestamptz,
  voided_by uuid references app.people (id),
  void_reason text,
  deleted_at timestamptz,
  constraint expense_reimbursements_paid_positive check (paid_minor > 0),
  constraint expense_reimbursements_reference_length check (reference_identifier is null
    or char_length(btrim(reference_identifier)) between 1 and 200),
  constraint expense_reimbursements_void_reason_length check (void_reason is null
    or char_length(btrim(void_reason)) between 1 and 500),
  constraint expense_reimbursements_void_complete check (num_nonnulls(voided_at, voided_by, void_reason) in (0, 3))
);

create index expense_reimbursements_org_payee_idx on app.expense_reimbursements (org_id, payee_person_id);
create index expense_reimbursements_payee_person_id_idx on app.expense_reimbursements (payee_person_id);
create index expense_reimbursements_currency_code_idx on app.expense_reimbursements (currency_code);
create index expense_reimbursements_voided_by_idx on app.expense_reimbursements (voided_by);

call private.install_domain_table('app.expense_reimbursements');
call private.describe('app.expense_reimbursements', 'Reimbursements of out-of-pocket expenses to the person who filed them (G-228, ADR 0151 item 2): the money recorded as moved, by a person holding finance.payment.write who is not the payee, with the date and remittance reference. XOS records the payment and moves no money (decision 20). Not app.payments: a reimbursement is not a payment for work. Written only by app.record_expense_reimbursement and voided only by app.void_expense_reimbursement.', array[
  'payee_person_id', 'Person reimbursed: the submitter of every expense the reimbursement settles.',
  'currency_code', 'ISO 4217 currency of the expenses and the amount.',
  'paid_minor', 'Amount recorded as paid, in minor units: the net owed on the expenses when it was recorded (each amount less its approved credits).',
  'paid_on', 'Date the money moved.',
  'reference_identifier', 'Remittance reference of the movement, such as a bank or card reference.',
  'voided_at', 'When the reimbursement was voided; NULL while it stands.',
  'voided_by', 'Person who voided it.',
  'void_reason', 'Why it was voided.'
]);

call private.install_policies('app.expense_reimbursements',
  $$org_id in (select private.orgs_with_capability('finance.payment.read'))
    or payee_person_id = (select private.current_person_id())$$);
call private.install_default_retention('app.expense_reimbursements');
call private.install_audit_trail('app.expense_reimbursements');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('expense_reimbursements', 'A reimbursement is voided through app.void_expense_reimbursement and never restored from Trash.')
on conflict (table_name) do nothing;

-- 2. Expense columns --------------------------------------------------------------------------------------------------

alter table app.expenses
  add column credit_of_expense_id uuid references app.expenses (id),
  add column is_reimbursable boolean not null default false,
  add column reimbursement_id uuid references app.expense_reimbursements (id),
  add constraint expenses_credit_not_self check (credit_of_expense_id is distinct from id),
  add constraint expenses_reimbursable_submitter check (not is_reimbursable or submitter_person_id is not null),
  add constraint expenses_credit_not_reimbursable check (credit_of_expense_id is null or not is_reimbursable),
  add constraint expenses_reimbursement_reimbursable check (reimbursement_id is null or is_reimbursable);

create index expenses_credit_of_expense_id_idx on app.expenses (credit_of_expense_id);
create index expenses_reimbursement_id_idx on app.expenses (reimbursement_id);

comment on table app.expenses is 'Expenses. One expense posts to exactly one budget line (invariant 12): a single required budget line that never changes. Approval posts it to the ledger. A credit (credit_of_expense_id set) is a refund or vendor credit against an approved or paid charge: its amount stays positive, it sits on the charge''s line in its currency and with its counterparty, its approval reverses the charge''s posting, and Actual nets approved credits (3010, 3011). A reimbursable charge (is_reimbursable) was paid by its submitter, who is owed it until a reimbursement is recorded (3012).';
comment on column app.expenses.amount_minor is 'Amount in minor units of currency_code, always positive. An expense is a claim, so the amount is required; a credit''s amount is what it takes back from its original.';
comment on column app.expenses.counterparty_id is 'Vendor paid, when there is one. A credit carries its original''s.';
comment on column app.expenses.credit_of_expense_id is 'The charge this credit refunds or credits, when the row is a credit: a live Approved or Paid charge of the same org on the same budget line. Never changes.';
comment on column app.expenses.is_reimbursable is 'True when the submitter paid out of pocket and is owed the amount. Needs a submitter, is never set on a credit, and is fixed once the expense leaves Proposed.';
comment on column app.expenses.reimbursement_id is 'Reimbursement that settled the expense; set and cleared only by app.record_expense_reimbursement and app.void_expense_reimbursement.';

-- install_tenant_guards replaces t30 with only the references listed, so the call restates 0321's counterparty.
call private.install_tenant_guards('app.expenses', 'app.budget_lines', 'budget_line_id',
  array['app.counterparties', 'counterparty_id', 'app.expenses', 'credit_of_expense_id',
        'app.expense_reimbursements', 'reimbursement_id']);

-- 3. The guard (from 0321) --------------------------------------------------------------------------------------------

create or replace function private.guard_expense()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget app.budgets;
  v_original app.expenses;
  v_credited bigint;
  v_check_credit boolean := false;
begin
  select b.* into v_budget from app.budgets b join app.budget_lines bl on bl.budget_id = b.id where bl.id = new.budget_line_id;
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.submitter_person_id := private.current_person_id();
    end if;
    perform private.assert_production_open(v_budget.project_id);
    if new.reimbursement_id is not null then
      perform private.refuse('expense_reimbursement_rpc', 'An expense is reimbursed through app.record_expense_reimbursement.');
    end if;
    if new.credit_of_expense_id is not null then
      -- A credit uses up its original's creditable amount, so beyond the finance.expense.write insert policy (0321) only
      -- the approver's or the payer's side records one.
      if auth.uid() is not null
         and not private.can_on_project(v_budget.project_id, 'finance.expense.approve')
         and not private.has_capability(new.org_id, 'finance.payment.write') then
        raise exception using errcode = '42501',
          message = 'finance.expense.approve on the project or finance.payment.write is required to record a credit';
      end if;
      v_check_credit := true;
    end if;
  else
    if new.budget_line_id <> old.budget_line_id then
      perform private.refuse('expense_budget_line_immutable', 'An expense posts to exactly one budget line, which never changes.');
    end if;
    if new.submitter_person_id is distinct from old.submitter_person_id then
      perform private.refuse('expense_submitter_immutable', 'The submitter of an expense never changes.');
    end if;
    if old.expense_state <> 'Proposed' and (new.amount_minor <> old.amount_minor or new.currency_code <> old.currency_code
        or new.incurred_on <> old.incurred_on) then
      perform private.refuse('expense_locked', 'An expense''s amount and date change only while it is Proposed.');
    end if;
    if new.credit_of_expense_id is distinct from old.credit_of_expense_id then
      perform private.refuse('expense_credit_immutable', 'A credit stays against the expense it credits, and a charge never becomes a credit.');
    end if;
    if old.credit_of_expense_id is not null and new.counterparty_id is distinct from old.counterparty_id then
      perform private.refuse('expense_credit_immutable', 'A credit keeps the vendor of the expense it credits.');
    end if;
    if new.deleted_at is not null and old.deleted_at is null and old.credit_of_expense_id is not null
       and old.expense_state in ('Approved', 'Paid') then
      perform private.refuse('expense_credit_posted', 'An approved credit has posted its reversal, so it stays out of Trash.');
    end if;
    if new.is_reimbursable <> old.is_reimbursable and old.expense_state <> 'Proposed' then
      perform private.refuse('expense_reimbursable_locked', 'Whether an expense is reimbursable changes only while it is Proposed.');
    end if;
    if new.reimbursement_id is distinct from old.reimbursement_id
       and not private.in_trusted_operation('expense_reimbursement') then
      perform private.refuse('expense_reimbursement_rpc', 'An expense is reimbursed through app.record_expense_reimbursement.');
    end if;
    if old.reimbursement_id is not null and not private.in_trusted_operation('expense_reimbursement')
       and (new.deleted_at is not null and old.deleted_at is null
         or new.description <> old.description
         or new.counterparty_id is distinct from old.counterparty_id) then
      perform private.refuse('expense_reimbursed_locked', 'A reimbursed expense keeps what it was for and stays out of Trash; void the reimbursement first.');
    end if;
    if new.deleted_at is not null and old.deleted_at is null and old.credit_of_expense_id is null
       and exists (select 1 from app.expenses c
                   where c.credit_of_expense_id = old.id and c.deleted_at is null
                     and c.expense_state not in ('Rejected', 'Canceled')) then
      perform private.refuse('expense_has_credits', 'An expense with credits stays out of Trash while they stand; cancel or reject them first.');
    end if;
    -- A credit comes back into play when its amount changes while Proposed, when it is resubmitted, or when it is
    -- restored from Trash: the original is checked again.
    if new.credit_of_expense_id is not null and new.deleted_at is null
       and (new.amount_minor <> old.amount_minor
         or (old.expense_state = 'Rejected' and new.expense_state = 'Proposed')
         or old.deleted_at is not null) then
      v_check_credit := true;
    end if;
  end if;
  if new.currency_code <> v_budget.currency_code then
    perform private.refuse('expense_currency', format('The expense is in %s but its budget is in %s.', new.currency_code, v_budget.currency_code));
  end if;

  if v_check_credit then
    select * into v_original from app.expenses e where e.id = new.credit_of_expense_id for update;
    if v_original.id is null or v_original.deleted_at is not null or v_original.credit_of_expense_id is not null
       or v_original.org_id <> new.org_id or v_original.expense_state not in ('Approved', 'Paid') then
      perform private.refuse('expense_credit_original', 'A credit is against a live Approved or Paid expense of the org that is not itself a credit.');
    end if;
    if new.budget_line_id <> v_original.budget_line_id then
      perform private.refuse('expense_credit_line', 'A credit posts to the budget line of the expense it credits.');
    end if;
    if tg_op = 'INSERT' then
      new.counterparty_id := v_original.counterparty_id;
    end if;
    if v_original.is_reimbursable and v_original.expense_state = 'Paid' then
      perform private.refuse('expense_credit_reimbursed', 'This expense was reimbursed to the person who paid it, so a refund on it is theirs.');
    end if;
    select coalesce(sum(c.amount_minor), 0) into v_credited
    from app.expenses c
    where c.credit_of_expense_id = v_original.id and c.deleted_at is null and c.id <> new.id
      and c.expense_state not in ('Rejected', 'Canceled');
    if v_credited + new.amount_minor > v_original.amount_minor then
      perform private.refuse('expense_credit_exceeds', format('Credits on this expense would reach %s of its %s.',
        v_credited + new.amount_minor, v_original.amount_minor));
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_expense() is 'Expenses: submitter from the session, budget line fixed (invariant 12), amount locked after submission, budget currency, and no new expense on a closed production (invariant 10), credits included. A credit (3010) is inserted under the finance.expense.write policy (0321) and also needs finance.expense.approve on the project or finance.payment.write in the org, against a live Approved or Paid charge of the org on the same line (expense_credit_original, expense_credit_line) that was not reimbursed to its payer (expense_credit_reimbursed), takes its counterparty, and keeps the live credits that are not Rejected or Canceled within the charge (expense_credit_exceeds); the same checks run when a credit''s amount changes, when it is resubmitted and when it is restored from Trash. The credit link and a credit's counterparty never change (expense_credit_immutable), an Approved or Paid credit stays out of Trash (expense_credit_posted), the reimbursable flag is fixed after Proposed (expense_reimbursable_locked), the reimbursement link changes only inside the reimbursement RPCs (expense_reimbursement_rpc), a reimbursed expense keeps its description and counterparty and stays out of Trash (expense_reimbursed_locked), and a charge with standing credits stays out of Trash (expense_has_credits).';
revoke all on function private.guard_expense() from public, anon, authenticated;
