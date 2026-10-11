-- 0321_finance_documents.sql
-- A03 Domain Data. Finance documents (Section 7.4 Finance, Section 7.5 invariants 10 to 13 and 16,
-- Sections 8.1 and 8.2): expenses (one expense posts to exactly one budget line), contingency draws,
-- change orders and their lines (an unpriced change order is never stored at zero), invoices and
-- their lines, payments and payment applications (billed-to-date counts each payment once), billing
-- draws, tax jurisdictions and rates, FX rates, and the NULL-aware aggregate views with unpriced counts.
-- Every approval runs spend authority and the separation of duties rule that applies, inside the RPC.

-- Lifecycle installer ------------------------------------------------------------------------------------
-- Creates app.<lifecycle>_state_transitions for a subject table, guards the subject's state column,
-- writes the creation entry, and installs the ledger read policy.

create or replace procedure private.install_lifecycle(
  p_subject regclass,
  p_subject_column text,
  p_state_column text,
  p_lifecycle text,
  p_initial text,
  p_ledger_read text
)
language plpgsql
set search_path = ''
as $$
declare
  v_type text := (select format_type(a.atttypid, a.atttypmod) from pg_catalog.pg_attribute a
                  where a.attrelid = p_subject and a.attname = p_state_column);
  v_ledger text := 'app.' || p_lifecycle || '_state_transitions';
  v_label text := replace(p_lifecycle, '_', ' ');
begin
  execute format($f$
    create table %s (
      id uuid primary key default private.uuid_v7(),
      org_id uuid not null references app.organizations (id),
      %I uuid not null references %s (id),
      from_state %s,
      to_state %s not null,
      reason text not null,
      constraint %I check (char_length(btrim(reason)) between 1 and 500)
    )$f$, v_ledger, p_subject_column, p_subject, v_type, v_type, p_lifecycle || '_state_transitions_reason_length');
  execute format('create index %I on %s (%I)', p_lifecycle || '_state_transitions_subject_idx', v_ledger, p_subject_column);
  call private.install_domain_table(v_ledger::regclass, p_subject::text, p_subject_column, '{}', true);
  call private.describe(v_ledger::regclass,
    format('Append-only ledger of %s state changes, written only by the %s transition RPCs and creation.', v_label, v_label),
    array[
      p_subject_column, format('The %s that changed state.', v_label),
      'from_state', 'State before the change; NULL for the creation entry.',
      'to_state', 'State after the change.',
      'reason', 'Why the state changed.'
    ]);
  call private.install_policies(v_ledger::regclass, p_ledger_read);
  execute format('create trigger %I before insert or update on %s for each row execute function private.guard_lifecycle_state(%L, %L, %L)',
    't41_' || p_lifecycle || '_state', p_subject, p_state_column, p_lifecycle, p_initial);
  execute format('create trigger %I after insert on %s for each row execute function private.log_initial_state(%L, %L, %L)',
    't80_log_' || p_lifecycle || '_state', p_subject, v_ledger, p_subject_column, p_state_column);
end;
$$;

comment on procedure private.install_lifecycle(regclass, text, text, text, text, text) is 'Gives a table a lifecycle state machine: creates its *_state_transitions ledger, guards the state column (initial state on insert, changes only through private.transition_lifecycle) and writes the creation entry.';
revoke all on procedure private.install_lifecycle(regclass, text, text, text, text, text) from public, anon, authenticated;

-- Enums and rules -----------------------------------------------------------------------------------------------

create type app.expense_state as enum ('Proposed', 'Approved', 'Rejected', 'Paid', 'Canceled');
comment on type app.expense_state is 'Expense states: submitted (Proposed), Approved or Rejected by an eligible approver, Paid, or Canceled. Approved and Rejected are declared extensions of the shared vocabulary.';

create type app.change_order_state as enum ('Proposed', 'Priced', 'Approved', 'Rejected', 'Canceled');
comment on type app.change_order_state is 'Change order states. Only a fully priced change order (Priced) can be approved.';

create type app.invoice_state as enum ('Proposed', 'Issued', 'Approved', 'Disputed', 'Canceled');
comment on type app.invoice_state is 'Invoice states: drafted or received (Proposed), Issued to a client (receivable), Approved for payment (payable), Disputed, or Canceled.';

create type app.payment_state as enum ('Proposed', 'Approved', 'Canceled');
comment on type app.payment_state is 'Payment states: recorded (Proposed), Approved by an eligible approver, or Canceled.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('expense', 'Proposed', 'Approved'),
  ('expense', 'Proposed', 'Rejected'),
  ('expense', 'Proposed', 'Canceled'),
  ('expense', 'Rejected', 'Proposed'),
  ('expense', 'Approved', 'Paid'),
  ('change_order', 'Proposed', 'Priced'),
  ('change_order', 'Proposed', 'Canceled'),
  ('change_order', 'Priced', 'Proposed'),
  ('change_order', 'Priced', 'Approved'),
  ('change_order', 'Priced', 'Rejected'),
  ('change_order', 'Priced', 'Canceled'),
  ('change_order', 'Rejected', 'Proposed'),
  ('invoice', 'Proposed', 'Issued'),
  ('invoice', 'Proposed', 'Approved'),
  ('invoice', 'Proposed', 'Canceled'),
  ('invoice', 'Issued', 'Disputed'),
  ('invoice', 'Issued', 'Canceled'),
  ('invoice', 'Approved', 'Disputed'),
  ('invoice', 'Disputed', 'Issued'),
  ('invoice', 'Disputed', 'Approved'),
  ('invoice', 'Disputed', 'Canceled'),
  ('payment', 'Proposed', 'Approved'),
  ('payment', 'Proposed', 'Canceled');

insert into private.domain_event_types (code, subject, description) values
  ('expense.submitted', 'expenses', 'An expense was submitted against a budget line.'),
  ('expense.approved', 'expenses', 'An expense was approved and posted to the ledger.'),
  ('change_order.approved', 'change_orders', 'A priced change order was approved under spend authority.'),
  ('invoice.issued', 'invoices', 'A receivable invoice was issued to a client.'),
  ('invoice.approved', 'invoices', 'A payable invoice was approved for payment under spend authority.'),
  ('payment.approved', 'payments', 'A payment was approved.');

-- Helpers ----------------------------------------------------------------------------------------------------------

create or replace function private.budget_line_ids_with(p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select bl.id from app.budget_lines bl
  join app.budgets b on b.id = bl.budget_id
  where b.project_id in (select private.project_ids_with(p_capability)) and bl.deleted_at is null and b.deleted_at is null;
$$;

comment on function private.budget_line_ids_with(text) is 'Budget lines of projects on which the signed-in person may use a capability (invariant 2).';
revoke all on function private.budget_line_ids_with(text) from public, anon;
grant execute on function private.budget_line_ids_with(text) to authenticated, service_role;

create or replace function private.extended_minor(p_quantity numeric, p_unit_price_minor bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select round(p_quantity * p_unit_price_minor)::bigint;
$$;

comment on function private.extended_minor(numeric, bigint) is 'Quantity times unit price in minor units, rounded half away from zero. NULL when the unit price is NULL (Section 3.7: a blank price stays blank).';
revoke all on function private.extended_minor(numeric, bigint) from public, anon;
grant execute on function private.extended_minor(numeric, bigint) to authenticated, service_role;

-- Tax and FX -------------------------------------------------------------------------------------------------------

create table app.tax_jurisdictions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  jurisdiction_id text not null references xpms.jurisdiction (jurisdiction_id),
  name text not null,
  deleted_at timestamptz,
  constraint tax_jurisdictions_name_length check (char_length(btrim(name)) between 1 and 200)
);

create index tax_jurisdictions_jurisdiction_id_idx on app.tax_jurisdictions (jurisdiction_id);
create unique index tax_jurisdictions_org_jurisdiction_key on app.tax_jurisdictions (org_id, jurisdiction_id) where deleted_at is null;

call private.install_domain_table('app.tax_jurisdictions');
call private.describe('app.tax_jurisdictions', 'Tax jurisdictions an org collects or pays tax in, bound to a canon jurisdiction.', array[
  'jurisdiction_id', 'Canon jurisdiction the tax authority covers.',
  'name', 'Name of the tax jurisdiction as the authority states it.'
]);

create table app.tax_rates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  tax_jurisdiction_id uuid not null references app.tax_jurisdictions (id),
  tax_type text not null,
  rate_percent numeric(7, 4) not null,
  effective_from date not null,
  effective_to date,
  deleted_at timestamptz,
  constraint tax_rates_rate_range check (rate_percent >= 0 and rate_percent <= 100),
  constraint tax_rates_effective check (effective_to is null or effective_to >= effective_from)
);

create index tax_rates_tax_jurisdiction_id_idx on app.tax_rates (tax_jurisdiction_id, tax_type, effective_from);

call private.install_domain_table('app.tax_rates', 'app.tax_jurisdictions', 'tax_jurisdiction_id');
call private.describe('app.tax_rates', 'Tax rates of a tax jurisdiction over time. Rates of one jurisdiction and tax type never overlap.', array[
  'tax_jurisdiction_id', 'Tax jurisdiction the rate belongs to.',
  'tax_type', 'Canon tax type the rate applies to (Bible tab 29 tax types).',
  'rate_percent', 'Rate in percent, 0 to 100.',
  'effective_from', 'First day the rate applies.',
  'effective_to', 'Last day the rate applies; NULL while current.'
]);

create or replace function private.guard_tax_rate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from xpms.dim_gl_account a where a.tax_type = new.tax_type) then
    perform private.refuse('tax_type_unknown', format('%s is not a canon tax type.', new.tax_type));
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tax_rates:' || new.tax_jurisdiction_id::text, 0));
  if new.deleted_at is null and exists (
    select 1 from app.tax_rates r
    where r.tax_jurisdiction_id = new.tax_jurisdiction_id and r.tax_type = new.tax_type and r.id <> new.id and r.deleted_at is null
      and daterange(r.effective_from, r.effective_to, '[]') && daterange(new.effective_from, new.effective_to, '[]')
  ) then
    perform private.refuse('tax_rate_overlap', 'Rates of one tax jurisdiction and tax type never overlap.');
  end if;
  return new;
end;
$$;

comment on function private.guard_tax_rate() is 'Tax rates: canon tax type and no overlapping periods per jurisdiction and type.';

create trigger t40_guard_tax_rate before insert or update on app.tax_rates
  for each row execute function private.guard_tax_rate();

create table app.fx_rates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  base_currency char(3) not null references private.currencies (currency_code),
  quote_currency char(3) not null references private.currencies (currency_code),
  rate numeric not null,
  effective_on date not null,
  source text not null,
  deleted_at timestamptz,
  constraint fx_rates_distinct check (base_currency <> quote_currency),
  constraint fx_rates_positive check (rate > 0),
  constraint fx_rates_source_length check (char_length(btrim(source)) between 1 and 200)
);

create index fx_rates_base_currency_idx on app.fx_rates (base_currency);
create index fx_rates_quote_currency_idx on app.fx_rates (quote_currency);
create unique index fx_rates_org_pair_day_key on app.fx_rates (org_id, base_currency, quote_currency, effective_on) where deleted_at is null;

call private.install_domain_table('app.fx_rates');
call private.describe('app.fx_rates', 'Exchange rates an org converts with: one unit of base_currency buys rate units of quote_currency on effective_on.', array[
  'base_currency', 'ISO 4217 currency converted from.',
  'quote_currency', 'ISO 4217 currency converted to.',
  'rate', 'Units of quote_currency per unit of base_currency.',
  'effective_on', 'Day the rate applies to.',
  'source', 'Where the rate came from, for example the bank or feed.'
]);

-- Expenses (invariant 12) -------------------------------------------------------------------------------------------

create table app.expenses (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  budget_line_id uuid not null references app.budget_lines (id),
  counterparty_id uuid references app.counterparties (id),
  submitter_person_id uuid references app.people (id),
  description text not null,
  incurred_on date not null,
  amount_minor bigint not null,
  currency_code char(3) not null references private.currencies (currency_code),
  expense_state app.expense_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint expenses_amount_positive check (amount_minor > 0),
  constraint expenses_description_length check (char_length(btrim(description)) between 1 and 500)
);

create index expenses_budget_line_id_idx on app.expenses (budget_line_id);
create index expenses_counterparty_id_idx on app.expenses (counterparty_id);
create index expenses_submitter_person_id_idx on app.expenses (submitter_person_id);
create index expenses_currency_code_idx on app.expenses (currency_code);

call private.install_domain_table('app.expenses', 'app.budget_lines', 'budget_line_id', array['app.counterparties', 'counterparty_id']);
call private.describe('app.expenses', 'Expenses. One expense posts to exactly one budget line (invariant 12): a single required budget line that never changes. Approval posts it to the ledger.', array[
  'budget_line_id', 'The one budget line the expense posts to. Never changes.',
  'counterparty_id', 'Vendor paid, when there is one.',
  'submitter_person_id', 'Person who submitted the expense, set from the session; they cannot approve it.',
  'description', 'What was bought.',
  'incurred_on', 'Date the cost was incurred; its accounting period must accept postings when approved.',
  'amount_minor', 'Amount in minor units of currency_code. An expense is a claim, so the amount is required.',
  'currency_code', 'ISO 4217 currency; equals the budget currency.',
  'expense_state', 'Expense state. Changes only through the expense RPCs.'
]);

call private.install_lifecycle('app.expenses', 'expense_id', 'expense_state', 'expense', 'Proposed',
  $$expense_id in (select e.id from app.expenses e where e.budget_line_id in (select private.budget_line_ids_with('finance.expense.read')))$$);

create or replace function private.guard_expense()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget app.budgets;
begin
  select b.* into v_budget from app.budgets b join app.budget_lines bl on bl.budget_id = b.id where bl.id = new.budget_line_id;
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.submitter_person_id := private.current_person_id();
    end if;
    perform private.assert_production_open(v_budget.project_id);
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
  end if;
  if new.currency_code <> v_budget.currency_code then
    perform private.refuse('expense_currency', format('The expense is in %s but its budget is in %s.', new.currency_code, v_budget.currency_code));
  end if;
  return new;
end;
$$;

comment on function private.guard_expense() is 'Expenses: submitter from the session, budget line fixed (invariant 12), amount locked after submission, budget currency, and no new expense on a closed production (invariant 10).';

create trigger t40_guard_expense before insert or update on app.expenses
  for each row execute function private.guard_expense();
create trigger t90_emit_expense_submitted after insert on app.expenses
  for each row execute function private.emit_subject_event('expense.submitted', 'expenses', 'id', 'budget_line_id', 'amount_minor', 'currency_code');
create trigger t90_emit_expense_approved after insert on app.expense_state_transitions
  for each row when (new.to_state = 'Approved')
  execute function private.emit_subject_event('expense.approved', 'expenses', 'expense_id', 'from_state', 'to_state');

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
  v_approved boolean;
  v_entry uuid;
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
  v_account := private.gl_account_for(v_line.urid, 'Expense');
  if v_account is null then
    perform private.refuse('gl_account_unresolved', format('No expense account resolves for %s.', v_line.urid));
  end if;
  v_approved := private.approve_under_spend_authority(v_expense.org_id, 'Expense', v_expense.id, v_expense.amount_minor,
    v_expense.currency_code, v_account, v_line.cost_center_id);
  if not v_approved then
    return false;
  end if;
  perform private.transition_lifecycle('expense', 'app.expenses', 'expense_state', 'app.expense_state_transitions',
    'expense_id', v_expense.id, 'Proposed', 'Approved', p_reason);

  perform private.begin_trusted_operation('system_journal');
  insert into app.journal_entries (accounting_period_id, project_id, entry_date, memo, source_table, source_id)
  values (private.postable_period(v_expense.org_id, v_expense.incurred_on), v_project, v_expense.incurred_on,
          v_expense.description, 'expenses', v_expense.id)
  returning id into v_entry;
  perform private.end_trusted_operation('system_journal');
  insert into app.journal_lines (journal_entry_id, line_number, account_code, cost_center_id, urid, counterparty_id,
    description, debit_minor, credit_minor, currency_code) values
    (v_entry, 1, v_account, v_line.cost_center_id, v_line.urid, v_expense.counterparty_id, v_expense.description,
     v_expense.amount_minor, 0, v_expense.currency_code),
    (v_entry, 2, '2000', v_line.cost_center_id, v_line.urid, v_expense.counterparty_id, v_expense.description,
     0, v_expense.amount_minor, v_expense.currency_code);
  perform private.post_journal(v_entry, 'Expense approved.');
  return true;
end;
$$;

comment on function app.approve_expense(uuid, text) is 'Approves a submitted expense: needs finance.expense.approve on the project, refuses the submitter (sod_expense_submitter), applies spend authority (two approvers above the dual threshold), then moves it to Approved and posts it to the class expense account against Accounts Payable in the period covering incurred_on (invariant 13). Returns true once fully approved.';

create or replace function app.reject_expense(p_expense_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_expense app.expenses;
  v_project uuid;
begin
  select * into v_expense from app.expenses e where e.id = p_expense_id and e.deleted_at is null;
  select b.project_id into v_project from app.budgets b join app.budget_lines bl on bl.budget_id = b.id where bl.id = v_expense.budget_line_id;
  if v_expense.id is null or not private.can_on_project(v_project, 'finance.expense.approve') then
    raise exception using errcode = '42501', message = 'finance.expense.approve is required on the project';
  end if;
  perform private.assert_separation('sod_expense_submitter', private.require_person(), v_expense.submitter_person_id);
  return private.transition_lifecycle('expense', 'app.expenses', 'expense_state', 'app.expense_state_transitions',
    'expense_id', p_expense_id, 'Proposed', 'Rejected', p_reason);
end;
$$;

comment on function app.reject_expense(uuid, text) is 'Rejects a submitted expense; the same eligibility and separation of duties as approval.';

create or replace function app.transition_expense(p_expense_id uuid, p_expected app.expense_state, p_next app.expense_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_expense app.expenses;
  v_project uuid;
begin
  if p_next in ('Approved', 'Rejected') then
    perform private.refuse('expense_use_approval_rpc', 'Approve or reject an expense through app.approve_expense or app.reject_expense.');
  end if;
  select * into v_expense from app.expenses e where e.id = p_expense_id and e.deleted_at is null;
  select b.project_id into v_project from app.budgets b join app.budget_lines bl on bl.budget_id = b.id where bl.id = v_expense.budget_line_id;
  if v_expense.id is null
     or (p_next = 'Paid' and not private.has_capability(v_expense.org_id, 'finance.payment.write'))
     or (p_next <> 'Paid' and v_expense.submitter_person_id is distinct from v_person
         and not private.can_on_project(v_project, 'finance.expense.write')) then
    raise exception using errcode = '42501', message = 'the person may not make this expense transition';
  end if;
  return private.transition_lifecycle('expense', 'app.expenses', 'expense_state', 'app.expense_state_transitions',
    'expense_id', p_expense_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_expense(uuid, app.expense_state, app.expense_state, text) is 'Cancels or resubmits an expense (its submitter or finance.expense.write) or marks it Paid (finance.payment.write). Approval and rejection go through their own RPCs.';

-- Contingency draws --------------------------------------------------------------------------------------------------

create table app.contingency_draws (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  from_budget_line_id uuid not null references app.budget_lines (id),
  to_budget_line_id uuid not null references app.budget_lines (id),
  amount_minor bigint not null,
  reason text not null,
  constraint contingency_draws_amount_positive check (amount_minor > 0),
  constraint contingency_draws_distinct check (from_budget_line_id <> to_budget_line_id),
  constraint contingency_draws_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index contingency_draws_from_idx on app.contingency_draws (from_budget_line_id);
create index contingency_draws_to_idx on app.contingency_draws (to_budget_line_id);

call private.install_domain_table('app.contingency_draws', 'app.budget_lines', 'from_budget_line_id',
  array['app.budget_lines', 'to_budget_line_id'], true);
call private.describe('app.contingency_draws', 'Append-only draws from a Contingency budget line to another line of the same budget. A draw never exceeds the contingency remaining, and an unpriced contingency cannot be drawn.', array[
  'from_budget_line_id', 'Contingency line drawn from.',
  'to_budget_line_id', 'Line of the same budget the amount moves to; never a Contingency line.',
  'amount_minor', 'Amount drawn in minor units of the budget currency.',
  'reason', 'Why the contingency was drawn.'
]);

create or replace function private.guard_contingency_draw()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from app.budget_lines;
  v_to app.budget_lines;
  v_drawn bigint;
begin
  select * into v_from from app.budget_lines bl where bl.id = new.from_budget_line_id for update;
  select * into v_to from app.budget_lines bl where bl.id = new.to_budget_line_id;
  if v_from.line_type <> 'Contingency' then
    perform private.refuse('contingency_source', 'Draws come from a Contingency line.');
  end if;
  if v_to.line_type = 'Contingency' or v_to.budget_id <> v_from.budget_id then
    perform private.refuse('contingency_target', 'Draws go to a non-contingency line of the same budget.');
  end if;
  if v_from.unit_price_minor is null then
    perform private.refuse('contingency_unpriced', 'An unpriced contingency has nothing to draw.');
  end if;
  select coalesce(sum(d.amount_minor), 0) into v_drawn from app.contingency_draws d
  where d.from_budget_line_id = new.from_budget_line_id and d.deleted_at is null;
  if v_drawn + new.amount_minor > private.extended_minor(v_from.quantity, v_from.unit_price_minor) then
    perform private.refuse('contingency_exhausted', 'The draw exceeds the contingency remaining.');
  end if;
  return new;
end;
$$;

comment on function private.guard_contingency_draw() is 'Contingency draws: from a priced Contingency line, to another line of the same budget, never beyond what remains.';

create trigger t40_guard_contingency_draw before insert on app.contingency_draws
  for each row execute function private.guard_contingency_draw();

-- Change orders (invariant 11) -------------------------------------------------------------------------------------------

create table app.change_orders (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  budget_id uuid not null references app.budgets (id),
  change_order_number bigint not null default 0,
  title text not null,
  order_type_enum_id text references xpms.std_enumeration (record_id),
  reason text,
  requested_by uuid references app.people (id),
  priced_by uuid references app.people (id),
  change_order_state app.change_order_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint change_orders_title_length check (char_length(btrim(title)) between 1 and 200)
);

create index change_orders_project_id_idx on app.change_orders (project_id);
create unique index change_orders_project_number_key on app.change_orders (project_id, change_order_number);
create index change_orders_budget_id_idx on app.change_orders (budget_id);
create index change_orders_order_type_enum_id_idx on app.change_orders (order_type_enum_id);
create index change_orders_requested_by_idx on app.change_orders (requested_by);
create index change_orders_priced_by_idx on app.change_orders (priced_by);

call private.install_domain_table('app.change_orders', 'app.projects', 'project_id', array['app.budgets', 'budget_id']);
call private.describe('app.change_orders', 'Change orders against a budget. The requester cannot approve (Section 8.2); only a fully priced change order can be approved, and its total is derived, NULL while any line is unpriced (invariant 11).', array[
  'project_id', 'Project the change order belongs to.',
  'budget_id', 'Budget of the same project the change order amends.',
  'change_order_number', 'Number from the project''s display key sequence, issued on insert.',
  'title', 'Change order title.',
  'order_type_enum_id', 'Order type: a row of the canon Order Type enumeration.',
  'reason', 'Why the change is needed.',
  'requested_by', 'Person who requested the change, set from the session.',
  'priced_by', 'Person who priced the change.',
  'change_order_state', 'Change order state. Changes only through the change order RPCs.'
]);

call private.install_lifecycle('app.change_orders', 'change_order_id', 'change_order_state', 'change_order', 'Proposed',
  $$change_order_id in (select c.id from app.change_orders c where c.project_id in (select private.project_ids_with('finance.change_order.read')))$$);

create table app.change_order_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  change_order_id uuid not null references app.change_orders (id),
  budget_line_id uuid references app.budget_lines (id),
  description text not null,
  urid text not null,
  quantity numeric not null default 1,
  unit_price_minor bigint,
  is_no_cost boolean not null default false,
  deleted_at timestamptz,
  constraint change_order_lines_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint change_order_lines_zero_is_declared check (unit_price_minor is distinct from 0 or is_no_cost),
  constraint change_order_lines_no_cost_is_zero check (not is_no_cost or unit_price_minor = 0)
);

create index change_order_lines_change_order_id_idx on app.change_order_lines (change_order_id);
create index change_order_lines_budget_line_id_idx on app.change_order_lines (budget_line_id);
create index change_order_lines_urid_idx on app.change_order_lines (urid);

call private.install_domain_table('app.change_order_lines', 'app.change_orders', 'change_order_id', array['app.budget_lines', 'budget_line_id']);
call private.describe('app.change_order_lines', 'Lines of a change order. A NULL unit price is unpriced; a zero price is stored only when declared no-cost, so an unpriced change order is never stored at zero (invariant 11). Lines change only while the change order is Proposed.', array[
  'change_order_id', 'Change order the line belongs to.',
  'budget_line_id', 'Budget line the change adjusts, when it adjusts an existing one.',
  'description', 'What changes.',
  'urid', 'Dimension 2 discipline or category of the change.',
  'quantity', 'Quantity.',
  'unit_price_minor', 'Unit price in minor units of the budget currency; NULL is unpriced.',
  'is_no_cost', 'True when the line is priced at zero on purpose. A zero price without it is refused.'
]);

create or replace function private.guard_change_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.assert_production_open(new.project_id);
    new.change_order_number := private.next_sequence(new.org_id, 'project:' || new.project_id::text);
    new.requested_by := case when auth.uid() is null then new.requested_by else private.current_person_id() end;
    new.priced_by := null;
  else
    if new.requested_by is distinct from old.requested_by or new.change_order_number <> old.change_order_number
       or new.project_id <> old.project_id or new.budget_id <> old.budget_id then
      perform private.refuse('change_order_immutable', 'A change order keeps its requester, number, project and budget.');
    end if;
    if new.priced_by is distinct from old.priced_by and not private.in_trusted_operation('change_order_transition') then
      perform private.refuse('change_order_priced_by', 'The pricer is recorded by app.price_change_order.');
    end if;
  end if;
  if (select b.project_id from app.budgets b where b.id = new.budget_id) <> new.project_id then
    perform private.refuse('change_order_budget_project', 'A change order amends a budget of its own project.');
  end if;
  perform private.assert_enumeration(new.order_type_enum_id, 'Order Type');
  return new;
end;
$$;

comment on function private.guard_change_order() is 'Change orders: number from the project sequence, requester from the session, budget of the same project, canon order type, no new change order on a closed production (invariant 10).';

create trigger t40_guard_change_order before insert or update on app.change_orders
  for each row execute function private.guard_change_order();
create trigger t90_emit_change_order_approved after insert on app.change_order_state_transitions
  for each row when (new.to_state = 'Approved')
  execute function private.emit_subject_event('change_order.approved', 'change_orders', 'change_order_id', 'from_state', 'to_state');

create or replace function private.guard_change_order_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order app.change_orders;
begin
  select * into v_order from app.change_orders c where c.id = new.change_order_id;
  if v_order.change_order_state <> 'Proposed' then
    perform private.refuse('change_order_locked', 'Change order lines change only while the change order is Proposed.');
  end if;
  if tg_op = 'UPDATE' and new.change_order_id <> old.change_order_id then
    perform private.refuse('change_order_line_immutable', 'A line stays on its change order.');
  end if;
  if new.budget_line_id is not null
     and (select bl.budget_id from app.budget_lines bl where bl.id = new.budget_line_id) <> v_order.budget_id then
    perform private.refuse('change_order_line_budget', 'A change order line adjusts a line of the change order''s budget.');
  end if;
  perform private.assert_urid(new.urid);
  return new;
end;
$$;

comment on function private.guard_change_order_line() is 'Change order lines: editable only while Proposed, on the change order''s budget, canon URID.';

create trigger t40_guard_change_order_line before insert or update on app.change_order_lines
  for each row execute function private.guard_change_order_line();

create or replace function private.change_order_total(p_change_order_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select case when count(*) = 0 or count(*) filter (where l.unit_price_minor is null) > 0 then null
              else sum(private.extended_minor(l.quantity, l.unit_price_minor))::bigint end
  from app.change_order_lines l where l.change_order_id = p_change_order_id and l.deleted_at is null;
$$;

comment on function private.change_order_total(uuid) is 'Total of a change order in minor units; NULL when it has no lines or any line is unpriced (invariant 11).';
revoke all on function private.change_order_total(uuid) from public, anon, authenticated;

create or replace function app.price_change_order(p_change_order_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order app.change_orders;
  v_entry uuid;
begin
  select * into v_order from app.change_orders c where c.id = p_change_order_id and c.deleted_at is null for update;
  if v_order.id is null or not private.can_on_project(v_order.project_id, 'finance.change_order.price') then
    raise exception using errcode = '42501', message = 'finance.change_order.price is required on the project';
  end if;
  if private.change_order_total(p_change_order_id) is null then
    perform private.refuse('change_order_unpriced', 'Every line of a change order needs a price, or a declared no-cost, before it is priced.');
  end if;
  perform private.begin_trusted_operation('change_order_transition');
  update app.change_orders set priced_by = private.require_person() where id = p_change_order_id;
  v_entry := private.transition_lifecycle('change_order', 'app.change_orders', 'change_order_state',
    'app.change_order_state_transitions', 'change_order_id', p_change_order_id, 'Proposed', 'Priced', p_reason);
  perform private.end_trusted_operation('change_order_transition');
  return v_entry;
end;
$$;

comment on function app.price_change_order(uuid, text) is 'Marks a change order Priced once every line is priced or declared no-cost. Needs finance.change_order.price on the project; records the pricer.';

create or replace function app.approve_change_order(p_change_order_id uuid, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_order app.change_orders;
  v_total bigint;
  v_currency char(3);
begin
  select * into v_order from app.change_orders c where c.id = p_change_order_id and c.deleted_at is null for update;
  if v_order.id is null or not private.can_on_project(v_order.project_id, 'finance.change_order.approve') then
    raise exception using errcode = '42501', message = 'finance.change_order.approve is required on the project';
  end if;
  perform private.assert_separation('sod_change_order_requester', v_person, v_order.requested_by);
  if v_order.change_order_state <> 'Priced' then
    perform private.refuse('change_order_not_priced', 'Only a priced change order can be approved.');
  end if;
  v_total := private.change_order_total(p_change_order_id);
  select b.currency_code into v_currency from app.budgets b where b.id = v_order.budget_id;
  if not private.approve_under_spend_authority(v_order.org_id, 'Change Order', v_order.id, greatest(v_total, 0), v_currency, null, null) then
    return false;
  end if;
  perform private.transition_lifecycle('change_order', 'app.change_orders', 'change_order_state',
    'app.change_order_state_transitions', 'change_order_id', p_change_order_id, 'Priced', 'Approved', p_reason);
  return true;
end;
$$;

comment on function app.approve_change_order(uuid, text) is 'Approves a priced change order: finance.change_order.approve on the project, never by its requester (sod_change_order_requester), under spend authority (two approvers above the dual threshold). Returns true once fully approved.';

create or replace function app.transition_change_order(p_change_order_id uuid, p_expected app.change_order_state, p_next app.change_order_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order app.change_orders;
  v_capability text := case when p_next = 'Rejected' then 'finance.change_order.approve' else 'finance.change_order.write' end;
begin
  if p_next in ('Priced', 'Approved') then
    perform private.refuse('change_order_use_rpc', 'Price and approve a change order through app.price_change_order and app.approve_change_order.');
  end if;
  select * into v_order from app.change_orders c where c.id = p_change_order_id and c.deleted_at is null;
  if v_order.id is null or not private.can_on_project(v_order.project_id, v_capability) then
    raise exception using errcode = '42501', message = format('%s is required on the project', v_capability);
  end if;
  if p_next = 'Rejected' then
    perform private.assert_separation('sod_change_order_requester', private.require_person(), v_order.requested_by);
  end if;
  return private.transition_lifecycle('change_order', 'app.change_orders', 'change_order_state',
    'app.change_order_state_transitions', 'change_order_id', p_change_order_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_change_order(uuid, app.change_order_state, app.change_order_state, text) is 'Reworks, rejects or cancels a change order with compare-and-set. Rejecting needs finance.change_order.approve and is refused to the requester; the rest needs finance.change_order.write.';

-- Invoices --------------------------------------------------------------------------------------------------------------

create table app.invoices (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  direction app.money_direction not null,
  counterparty_id uuid not null references app.counterparties (id),
  invoice_number text,
  issued_on date,
  due_on date,
  currency_code char(3) not null references private.currencies (currency_code),
  invoice_state app.invoice_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint invoices_due check (due_on is null or issued_on is null or due_on >= issued_on)
);

create index invoices_project_id_idx on app.invoices (project_id);
create index invoices_counterparty_id_idx on app.invoices (counterparty_id);
create index invoices_currency_code_idx on app.invoices (currency_code);
create unique index invoices_number_key on app.invoices (org_id, direction, counterparty_id, invoice_number)
  where invoice_number is not null and deleted_at is null;

call private.install_domain_table('app.invoices', 'app.projects', 'project_id', array['app.counterparties', 'counterparty_id']);
call private.describe('app.invoices', 'Invoices issued to clients (Receivable) and received from vendors (Payable). Totals and balances are derived (app.invoice_totals). A closed production refuses new invoices (invariant 10).', array[
  'project_id', 'Project the invoice belongs to.',
  'direction', 'Receivable (we bill) or Payable (we are billed).',
  'counterparty_id', 'Client billed or vendor billing.',
  'invoice_number', 'Invoice number: ours for a receivable, the vendor''s identifier for a payable.',
  'issued_on', 'Date the invoice was issued.',
  'due_on', 'Date payment is due.',
  'currency_code', 'ISO 4217 currency of the invoice.',
  'invoice_state', 'Invoice state. Changes only through the invoice RPCs.'
]);

call private.install_lifecycle('app.invoices', 'invoice_id', 'invoice_state', 'invoice', 'Proposed',
  $$invoice_id in (select i.id from app.invoices i where i.project_id in (select private.project_ids_with('finance.invoice.read')))$$);

create table app.invoice_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  invoice_id uuid not null references app.invoices (id),
  line_number integer not null,
  description text not null,
  quantity numeric not null default 1,
  unit_price_minor bigint,
  budget_line_id uuid references app.budget_lines (id),
  tax_rate_id uuid references app.tax_rates (id),
  deleted_at timestamptz,
  constraint invoice_lines_line_number_positive check (line_number > 0),
  constraint invoice_lines_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint invoice_lines_quantity_nonnegative check (quantity >= 0)
);

create unique index invoice_lines_invoice_number_key on app.invoice_lines (invoice_id, line_number) where deleted_at is null;
create index invoice_lines_budget_line_id_idx on app.invoice_lines (budget_line_id);
create index invoice_lines_tax_rate_id_idx on app.invoice_lines (tax_rate_id);

call private.install_domain_table('app.invoice_lines', 'app.invoices', 'invoice_id',
  array['app.budget_lines', 'budget_line_id', 'app.tax_rates', 'tax_rate_id']);
call private.describe('app.invoice_lines', 'Lines of an invoice. A NULL unit price is unpriced; an invoice with an unpriced line can be neither issued nor approved. Lines change only while the invoice is Proposed.', array[
  'invoice_id', 'Invoice the line belongs to.',
  'line_number', 'Order of the line within the invoice.',
  'description', 'What is billed.',
  'quantity', 'Quantity.',
  'unit_price_minor', 'Unit price in minor units of the invoice currency; NULL is unpriced.',
  'budget_line_id', 'Budget line the line bills against, when there is one.',
  'tax_rate_id', 'Tax rate applied to the line, when taxed.'
]);

create or replace function private.guard_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.assert_production_open(new.project_id);
  elsif new.project_id <> old.project_id or new.direction <> old.direction or new.counterparty_id <> old.counterparty_id
        or new.currency_code <> old.currency_code then
    perform private.refuse('invoice_immutable', 'An invoice keeps its project, direction, counterparty and currency.');
  end if;
  return new;
end;
$$;

comment on function private.guard_invoice() is 'Invoices: no new invoice on a closed production (invariant 10); project, direction, counterparty and currency fixed.';

create trigger t40_guard_invoice before insert or update on app.invoices
  for each row execute function private.guard_invoice();
create trigger t90_emit_invoice_issued after insert on app.invoice_state_transitions
  for each row when (new.to_state = 'Issued')
  execute function private.emit_subject_event('invoice.issued', 'invoices', 'invoice_id', 'from_state', 'to_state');
create trigger t90_emit_invoice_approved after insert on app.invoice_state_transitions
  for each row when (new.to_state = 'Approved')
  execute function private.emit_subject_event('invoice.approved', 'invoices', 'invoice_id', 'from_state', 'to_state');

create or replace function private.guard_invoice_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select i.invoice_state from app.invoices i where i.id = new.invoice_id) <> 'Proposed' then
    perform private.refuse('invoice_locked', 'Invoice lines change only while the invoice is Proposed.');
  end if;
  if tg_op = 'UPDATE' and new.invoice_id <> old.invoice_id then
    perform private.refuse('invoice_line_immutable', 'A line stays on its invoice.');
  end if;
  if new.budget_line_id is not null and (
    select b.project_id from app.budgets b join app.budget_lines bl on bl.budget_id = b.id where bl.id = new.budget_line_id
  ) <> (select i.project_id from app.invoices i where i.id = new.invoice_id) then
    perform private.refuse('invoice_line_budget', 'An invoice line bills against a budget line of the invoice''s project.');
  end if;
  return new;
end;
$$;

comment on function private.guard_invoice_line() is 'Invoice lines: editable only while Proposed, billed against a budget line of the same project.';

create trigger t40_guard_invoice_line before insert or update on app.invoice_lines
  for each row execute function private.guard_invoice_line();

create or replace function private.invoice_total(p_invoice_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select case when count(*) = 0 or count(*) filter (where l.unit_price_minor is null) > 0 then null
              else sum(private.extended_minor(l.quantity, l.unit_price_minor)
                       + coalesce(round(private.extended_minor(l.quantity, l.unit_price_minor) * r.rate_percent / 100)::bigint, 0))::bigint end
  from app.invoice_lines l
  left join app.tax_rates r on r.id = l.tax_rate_id
  where l.invoice_id = p_invoice_id and l.deleted_at is null;
$$;

comment on function private.invoice_total(uuid) is 'Total of an invoice including tax, in minor units; NULL when it has no lines or any line is unpriced.';
revoke all on function private.invoice_total(uuid) from public, anon, authenticated;

create or replace function app.issue_invoice(p_invoice_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invoice app.invoices;
begin
  select * into v_invoice from app.invoices i where i.id = p_invoice_id and i.deleted_at is null for update;
  if v_invoice.id is null or not private.can_on_project(v_invoice.project_id, 'finance.invoice.write') then
    raise exception using errcode = '42501', message = 'finance.invoice.write is required on the project';
  end if;
  if v_invoice.direction <> 'Receivable' then
    perform private.refuse('invoice_direction', 'Only a receivable invoice is issued; a payable invoice is approved.');
  end if;
  if private.invoice_total(p_invoice_id) is null then
    perform private.refuse('invoice_unpriced', 'Every line of an invoice needs a price before it is issued.');
  end if;
  if v_invoice.issued_on is null then
    update app.invoices set issued_on = current_date where id = p_invoice_id;
  end if;
  return private.transition_lifecycle('invoice', 'app.invoices', 'invoice_state', 'app.invoice_state_transitions',
    'invoice_id', p_invoice_id, 'Proposed', 'Issued', p_reason);
end;
$$;

comment on function app.issue_invoice(uuid, text) is 'Issues a fully priced receivable invoice (emits invoice.issued). Needs finance.invoice.write on the project.';

create or replace function app.approve_invoice(p_invoice_id uuid, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invoice app.invoices;
  v_total bigint;
  v_expected text;
begin
  select * into v_invoice from app.invoices i where i.id = p_invoice_id and i.deleted_at is null for update;
  if v_invoice.id is null or not private.can_on_project(v_invoice.project_id, 'finance.invoice.approve') then
    raise exception using errcode = '42501', message = 'finance.invoice.approve is required on the project';
  end if;
  if v_invoice.direction <> 'Payable' then
    perform private.refuse('invoice_direction', 'Only a payable invoice is approved for payment.');
  end if;
  perform private.assert_separation('sod_approval_requester', private.require_person(), v_invoice.created_by);
  v_total := private.invoice_total(p_invoice_id);
  if v_total is null then
    perform private.refuse('invoice_unpriced', 'Every line of an invoice needs a price before it is approved.');
  end if;
  if v_invoice.invoice_state not in ('Proposed', 'Disputed') then
    perform private.refuse('invoice_state_conflict', 'Only a Proposed or Disputed payable invoice can be approved.');
  end if;
  if not private.approve_under_spend_authority(v_invoice.org_id, 'Invoice Approval', v_invoice.id, v_total, v_invoice.currency_code, null, null) then
    return false;
  end if;
  v_expected := v_invoice.invoice_state::text;
  perform private.transition_lifecycle('invoice', 'app.invoices', 'invoice_state', 'app.invoice_state_transitions',
    'invoice_id', p_invoice_id, v_expected, 'Approved', p_reason);
  return true;
end;
$$;

comment on function app.approve_invoice(uuid, text) is 'Approves a fully priced payable invoice for payment: finance.invoice.approve on the project, never by the person who recorded it, under spend authority. Returns true once fully approved.';

create or replace function app.transition_invoice(p_invoice_id uuid, p_expected app.invoice_state, p_next app.invoice_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invoice app.invoices;
begin
  if p_next in ('Issued', 'Approved') then
    perform private.refuse('invoice_use_rpc', 'Issue or approve an invoice through app.issue_invoice or app.approve_invoice.');
  end if;
  select * into v_invoice from app.invoices i where i.id = p_invoice_id and i.deleted_at is null;
  if v_invoice.id is null or not private.can_on_project(v_invoice.project_id, 'finance.invoice.write') then
    raise exception using errcode = '42501', message = 'finance.invoice.write is required on the project';
  end if;
  return private.transition_lifecycle('invoice', 'app.invoices', 'invoice_state', 'app.invoice_state_transitions',
    'invoice_id', p_invoice_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_invoice(uuid, app.invoice_state, app.invoice_state, text) is 'Disputes, reissues or cancels an invoice with compare-and-set. Needs finance.invoice.write on the project.';

-- Payments and applications (invariant 16) ---------------------------------------------------------------------------------

create table app.payments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  counterparty_id uuid not null references app.counterparties (id),
  direction app.money_direction not null,
  amount_minor bigint not null,
  currency_code char(3) not null references private.currencies (currency_code),
  paid_on date not null,
  reference_identifier text,
  payment_state app.payment_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint payments_amount_positive check (amount_minor > 0)
);

create index payments_counterparty_id_idx on app.payments (counterparty_id);
create index payments_currency_code_idx on app.payments (currency_code);

call private.install_domain_table('app.payments', 'app.counterparties', 'counterparty_id');
call private.describe('app.payments', 'Payments made to or received from a counterparty. Applications spread a payment over invoices; a payment is never applied beyond its amount.', array[
  'counterparty_id', 'Counterparty paid or paying.',
  'direction', 'Payable (we pay) or Receivable (we are paid).',
  'amount_minor', 'Amount in minor units of currency_code.',
  'currency_code', 'ISO 4217 currency of the payment.',
  'paid_on', 'Date the money moved.',
  'reference_identifier', 'Bank or card reference of the movement.',
  'payment_state', 'Payment state. Changes only through the payment RPCs.'
]);

call private.install_lifecycle('app.payments', 'payment_id', 'payment_state', 'payment', 'Proposed',
  $$org_id in (select private.orgs_with_capability('finance.payment.read'))$$);

create trigger t90_emit_payment_approved after insert on app.payment_state_transitions
  for each row when (new.to_state = 'Approved')
  execute function private.emit_subject_event('payment.approved', 'payments', 'payment_id', 'from_state', 'to_state');

create or replace function private.guard_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.counterparty_id <> old.counterparty_id or new.direction <> old.direction
      or new.currency_code <> old.currency_code or new.amount_minor <> old.amount_minor) then
    perform private.refuse('payment_immutable', 'A payment keeps its counterparty, direction, currency and amount; cancel it and record another.');
  end if;
  return new;
end;
$$;

comment on function private.guard_payment() is 'Payments keep their counterparty, direction, currency and amount.';

create trigger t40_guard_payment before update on app.payments
  for each row execute function private.guard_payment();

create or replace function private.assert_payment_separation(p_approver uuid, p_counterparty_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from app.counterparties c where c.id = p_counterparty_id and c.created_by = p_approver) then
    perform private.assert_separation('sod_vendor_payment', p_approver, p_approver);
  end if;
end;
$$;

comment on function private.assert_payment_separation(uuid, uuid) is 'Section 8.2 sod_vendor_payment: the person who created the counterparty cannot approve payment to it. The vendor migration extends it to bank detail editors.';
revoke all on function private.assert_payment_separation(uuid, uuid) from public, anon, authenticated;

create or replace function app.approve_payment(p_payment_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_payment app.payments;
begin
  select * into v_payment from app.payments p where p.id = p_payment_id and p.deleted_at is null for update;
  if v_payment.id is null or not private.has_capability(v_payment.org_id, 'finance.payment.approve') then
    raise exception using errcode = '42501', message = 'finance.payment.approve is required';
  end if;
  perform private.assert_separation('sod_approval_requester', v_person, v_payment.created_by);
  if v_payment.direction = 'Payable' then
    perform private.assert_payment_separation(v_person, v_payment.counterparty_id);
  end if;
  return private.transition_lifecycle('payment', 'app.payments', 'payment_state', 'app.payment_state_transitions',
    'payment_id', p_payment_id, 'Proposed', 'Approved', p_reason);
end;
$$;

comment on function app.approve_payment(uuid, text) is 'Approves a recorded payment: finance.payment.approve, never by the person who recorded it, and for a payable payment never by a person who created the vendor or edited its bank details (sod_vendor_payment).';

create or replace function app.cancel_payment(p_payment_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select p.org_id from app.payments p where p.id = p_payment_id);
begin
  perform private.require_person();
  if v_org is null or not private.has_capability(v_org, 'finance.payment.write') then
    raise exception using errcode = '42501', message = 'finance.payment.write is required';
  end if;
  if exists (select 1 from app.payment_applications a where a.payment_id = p_payment_id and a.deleted_at is null) then
    perform private.refuse('payment_applied', 'Remove the payment''s applications before canceling it.');
  end if;
  return private.transition_lifecycle('payment', 'app.payments', 'payment_state', 'app.payment_state_transitions',
    'payment_id', p_payment_id, 'Proposed', 'Canceled', p_reason);
end;
$$;

comment on function app.cancel_payment(uuid, text) is 'Cancels a recorded, unapplied payment. Needs finance.payment.write.';

create table app.payment_applications (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  payment_id uuid not null references app.payments (id),
  invoice_id uuid not null references app.invoices (id),
  amount_minor bigint not null,
  deleted_at timestamptz,
  constraint payment_applications_amount_positive check (amount_minor > 0)
);

create index payment_applications_payment_id_idx on app.payment_applications (payment_id);
create index payment_applications_invoice_id_idx on app.payment_applications (invoice_id);
create unique index payment_applications_once_per_invoice on app.payment_applications (payment_id, invoice_id) where deleted_at is null;

call private.install_domain_table('app.payment_applications', 'app.payments', 'payment_id', array['app.invoices', 'invoice_id']);
call private.describe('app.payment_applications', 'How much of a payment settles which invoice. A payment applies to an invoice once and never beyond its amount, and an invoice is never paid beyond its total, so billed-to-date and paid-to-date count each payment once (invariant 16).', array[
  'payment_id', 'Payment applied.',
  'invoice_id', 'Invoice settled, with the same counterparty, direction and currency.',
  'amount_minor', 'Amount applied in minor units.'
]);

create or replace function private.guard_payment_application()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment app.payments;
  v_invoice app.invoices;
  v_applied bigint;
  v_paid bigint;
  v_total bigint;
begin
  if tg_op = 'UPDATE' and (new.payment_id <> old.payment_id or new.invoice_id <> old.invoice_id or new.amount_minor <> old.amount_minor) then
    perform private.refuse('payment_application_immutable', 'An application is removed and recorded again, never edited.');
  end if;
  if new.deleted_at is not null then
    return new;
  end if;
  select * into v_payment from app.payments p where p.id = new.payment_id for update;
  select * into v_invoice from app.invoices i where i.id = new.invoice_id for update;
  if v_payment.counterparty_id <> v_invoice.counterparty_id or v_payment.direction <> v_invoice.direction
     or v_payment.currency_code <> v_invoice.currency_code then
    perform private.refuse('payment_application_mismatch', 'A payment settles invoices of the same counterparty, direction and currency.');
  end if;
  if v_payment.payment_state = 'Canceled' or v_invoice.invoice_state not in ('Issued', 'Approved', 'Disputed') then
    perform private.refuse('payment_application_state', 'Apply live payments to issued or approved invoices.');
  end if;
  select coalesce(sum(a.amount_minor), 0) into v_applied from app.payment_applications a
  where a.payment_id = new.payment_id and a.deleted_at is null and a.id <> new.id;
  if v_applied + new.amount_minor > v_payment.amount_minor then
    perform private.refuse('payment_overapplied', 'A payment is never applied beyond its amount.');
  end if;
  v_total := private.invoice_total(new.invoice_id);
  select coalesce(sum(a.amount_minor), 0) into v_paid from app.payment_applications a
  where a.invoice_id = new.invoice_id and a.deleted_at is null and a.id <> new.id;
  if v_total is null or v_paid + new.amount_minor > v_total then
    perform private.refuse('invoice_overpaid', 'An invoice is never paid beyond its total.');
  end if;
  return new;
end;
$$;

comment on function private.guard_payment_application() is 'Invariant 16: an application matches counterparty, direction and currency, never exceeds the payment remaining or the invoice balance, and is never edited; the unique index applies a payment to an invoice once.';

create trigger t40_guard_payment_application before insert or update on app.payment_applications
  for each row execute function private.guard_payment_application();

-- Billing draws ------------------------------------------------------------------------------------------------------------

create table app.billing_draws (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  draw_number integer not null,
  period_end date not null,
  amount_requested_minor bigint not null,
  currency_code char(3) not null references private.currencies (currency_code),
  invoice_id uuid references app.invoices (id),
  deleted_at timestamptz,
  constraint billing_draws_number_positive check (draw_number > 0),
  constraint billing_draws_amount_positive check (amount_requested_minor > 0)
);

create unique index billing_draws_project_number_key on app.billing_draws (project_id, draw_number) where deleted_at is null;
create index billing_draws_currency_code_idx on app.billing_draws (currency_code);
create unique index billing_draws_invoice_key on app.billing_draws (invoice_id) where invoice_id is not null and deleted_at is null;

call private.install_domain_table('app.billing_draws', 'app.projects', 'project_id', array['app.invoices', 'invoice_id']);
call private.describe('app.billing_draws', 'Progress billing draws of a project, each billed through at most one receivable invoice.', array[
  'project_id', 'Project billed.',
  'draw_number', 'Draw number within the project.',
  'period_end', 'Last day of work the draw bills for.',
  'amount_requested_minor', 'Amount requested in minor units.',
  'currency_code', 'ISO 4217 currency of the draw.',
  'invoice_id', 'Receivable invoice that bills the draw.'
]);

-- Aggregate views (NULL-aware, Section 3.7, invariant 11) -------------------------------------------------------------------

create view app.budget_line_amounts with (security_invoker = true) as
select bl.id as budget_line_id, bl.budget_id, bl.line_type, bl.urid,
  private.gl_account_for(bl.urid, 'Expense') as account_code,
  private.extended_minor(bl.quantity, bl.unit_price_minor) as extended_minor,
  (bl.unit_price_minor is null) as is_unpriced,
  coalesce((select sum(d.amount_minor) from app.contingency_draws d where d.to_budget_line_id = bl.id and d.deleted_at is null), 0) as drawn_in_minor,
  coalesce((select sum(d.amount_minor) from app.contingency_draws d where d.from_budget_line_id = bl.id and d.deleted_at is null), 0) as drawn_out_minor,
  coalesce((select sum(e.amount_minor) from app.expenses e where e.budget_line_id = bl.id and e.deleted_at is null
            and e.expense_state in ('Approved', 'Paid')), 0) as actual_minor
from app.budget_lines bl
where bl.deleted_at is null;

call private.describe('app.budget_line_amounts', 'Budget line amounts, derived: extended amount (NULL when unpriced, never zero), contingency moved in and out, the GL account by class (decision D13) and approved spend.', array[
  'budget_line_id', 'Budget line.',
  'budget_id', 'Budget.',
  'line_type', 'Line type.',
  'urid', 'Dimension 2.',
  'account_code', 'Expense account the line posts to, derived from the URID class.',
  'extended_minor', 'Quantity times unit price in minor units; NULL when unpriced.',
  'is_unpriced', 'True when the unit price is NULL.',
  'drawn_in_minor', 'Contingency drawn into the line.',
  'drawn_out_minor', 'Contingency drawn out of the line.',
  'actual_minor', 'Approved and paid expenses posted to the line.'
]);

create view app.budget_totals with (security_invoker = true) as
select b.id as budget_id, b.project_id, b.currency_code,
  count(a.budget_line_id) as line_count,
  count(a.budget_line_id) filter (where a.is_unpriced) as unpriced_count,
  sum(a.extended_minor)::bigint as priced_total_minor,
  case when count(a.budget_line_id) = 0 or count(a.budget_line_id) filter (where a.is_unpriced) > 0 then null
       else sum(a.extended_minor)::bigint end as total_minor,
  coalesce(sum(a.actual_minor), 0)::bigint as actual_minor
from app.budgets b
left join app.budget_line_amounts a on a.budget_id = b.id
where b.deleted_at is null
group by b.id, b.project_id, b.currency_code;

call private.describe('app.budget_totals', 'Budget totals, NULL-aware: the total is NULL while any line is unpriced, with the unpriced count and the priced subtotal beside it (Section 3.7, invariant 11).', array[
  'budget_id', 'Budget.',
  'project_id', 'Project.',
  'currency_code', 'Currency of the budget.',
  'line_count', 'Lines in the budget.',
  'unpriced_count', 'Lines whose unit price is NULL.',
  'priced_total_minor', 'Sum of the priced lines only; NULL when no line is priced.',
  'total_minor', 'Budget total; NULL while any line is unpriced or the budget has no lines.',
  'actual_minor', 'Approved and paid expenses against the budget.'
]);

create view app.change_order_totals with (security_invoker = true) as
select c.id as change_order_id, c.project_id,
  count(l.id) as line_count,
  count(l.id) filter (where l.unit_price_minor is null) as unpriced_count,
  case when count(l.id) = 0 or count(l.id) filter (where l.unit_price_minor is null) > 0 then null
       else sum(private.extended_minor(l.quantity, l.unit_price_minor))::bigint end as total_minor
from app.change_orders c
left join app.change_order_lines l on l.change_order_id = c.id and l.deleted_at is null
where c.deleted_at is null
group by c.id, c.project_id;

call private.describe('app.change_order_totals', 'Change order totals: NULL while any line is unpriced, never zero, with the unpriced count (invariant 11).', array[
  'change_order_id', 'Change order.',
  'project_id', 'Project.',
  'line_count', 'Lines on the change order.',
  'unpriced_count', 'Lines whose unit price is NULL.',
  'total_minor', 'Total in minor units; NULL while any line is unpriced or there are no lines.'
]);

create view app.invoice_totals with (security_invoker = true) as
select i.id as invoice_id, i.project_id, i.direction, i.currency_code,
  count(l.id) filter (where l.unit_price_minor is null) as unpriced_count,
  case when count(l.id) = 0 or count(l.id) filter (where l.unit_price_minor is null) > 0 then null
       else sum(private.extended_minor(l.quantity, l.unit_price_minor))::bigint end as subtotal_minor,
  case when count(l.id) = 0 or count(l.id) filter (where l.unit_price_minor is null) > 0 then null
       else sum(coalesce(round(private.extended_minor(l.quantity, l.unit_price_minor) * r.rate_percent / 100)::bigint, 0))::bigint end as tax_minor,
  (select coalesce(sum(a.amount_minor), 0) from app.payment_applications a where a.invoice_id = i.id and a.deleted_at is null)::bigint as applied_minor
from app.invoices i
left join app.invoice_lines l on l.invoice_id = i.id and l.deleted_at is null
left join app.tax_rates r on r.id = l.tax_rate_id
where i.deleted_at is null
group by i.id, i.project_id, i.direction, i.currency_code;

call private.describe('app.invoice_totals', 'Invoice totals and settlement, NULL-aware: subtotal and tax are NULL while any line is unpriced.', array[
  'invoice_id', 'Invoice.',
  'project_id', 'Project.',
  'direction', 'Receivable or Payable.',
  'currency_code', 'Currency of the invoice.',
  'unpriced_count', 'Lines whose unit price is NULL.',
  'subtotal_minor', 'Sum of line amounts before tax; NULL while any line is unpriced.',
  'tax_minor', 'Tax on the lines; NULL while any line is unpriced.',
  'applied_minor', 'Payments applied to the invoice.'
]);

create view app.project_billing with (security_invoker = true) as
select p.id as project_id, i.currency_code,
  sum(t.subtotal_minor + t.tax_minor) filter (where i.invoice_state in ('Issued', 'Approved', 'Disputed'))::bigint as billed_to_date_minor,
  count(*) filter (where i.invoice_state in ('Issued', 'Approved', 'Disputed') and t.subtotal_minor is null) as unpriced_invoice_count,
  sum(t.applied_minor)::bigint as paid_to_date_minor
from app.projects p
join app.invoices i on i.project_id = p.id and i.direction = 'Receivable' and i.deleted_at is null
join app.invoice_totals t on t.invoice_id = i.id
where p.deleted_at is null
group by p.id, i.currency_code;

call private.describe('app.project_billing', 'Billed-to-date and paid-to-date per project and currency, from receivable invoices and their applications. Each payment counts once (invariant 16).', array[
  'project_id', 'Project.',
  'currency_code', 'Currency.',
  'billed_to_date_minor', 'Totals of issued, approved and disputed receivable invoices.',
  'unpriced_invoice_count', 'Billed invoices without a total.',
  'paid_to_date_minor', 'Payments applied to the project''s receivable invoices.'
]);

revoke all on app.budget_line_amounts, app.budget_totals, app.change_order_totals, app.invoice_totals, app.project_billing from public, anon;
grant select on app.budget_line_amounts, app.budget_totals, app.change_order_totals, app.invoice_totals, app.project_billing to authenticated, service_role;

-- Policies -------------------------------------------------------------------------------------------------------------------

call private.install_policies('app.tax_jurisdictions',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('finance.cost_center.write'))$$);
call private.install_policies('app.tax_rates',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('finance.cost_center.write'))$$);
call private.install_policies('app.fx_rates',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('finance.cost_center.write'))$$);

call private.install_policies('app.expenses',
  $$budget_line_id in (select private.budget_line_ids_with('finance.expense.read'))
    or submitter_person_id = (select private.current_person_id())$$,
  $$budget_line_id in (select private.budget_line_ids_with('finance.expense.write'))$$);

call private.install_policies('app.contingency_draws',
  $$from_budget_line_id in (select private.budget_line_ids_with('finance.budget.read'))$$,
  $$from_budget_line_id in (select private.budget_line_ids_with('finance.budget.write'))$$);

call private.install_policies('app.change_orders',
  $$project_id in (select private.project_ids_with('finance.change_order.read'))$$,
  $$project_id in (select private.project_ids_with('finance.change_order.write'))$$);
call private.install_policies('app.change_order_lines',
  $$change_order_id in (select c.id from app.change_orders c where c.project_id in (select private.project_ids_with('finance.change_order.read')))$$,
  $$change_order_id in (select c.id from app.change_orders c where c.project_id in (select private.project_ids_with('finance.change_order.write')))$$);

call private.install_policies('app.invoices',
  $$project_id in (select private.project_ids_with('finance.invoice.read'))$$,
  $$project_id in (select private.project_ids_with('finance.invoice.write'))$$);
call private.install_policies('app.invoice_lines',
  $$invoice_id in (select i.id from app.invoices i where i.project_id in (select private.project_ids_with('finance.invoice.read')))$$,
  $$invoice_id in (select i.id from app.invoices i where i.project_id in (select private.project_ids_with('finance.invoice.write')))$$);

call private.install_policies('app.payments',
  $$org_id in (select private.orgs_with_capability('finance.payment.read'))$$,
  $$org_id in (select private.orgs_with_capability('finance.payment.write'))$$);
call private.install_policies('app.payment_applications',
  $$org_id in (select private.orgs_with_capability('finance.payment.read'))$$,
  $$org_id in (select private.orgs_with_capability('finance.payment.write'))$$);

call private.install_policies('app.billing_draws',
  $$project_id in (select private.project_ids_with('finance.invoice.read'))$$,
  $$project_id in (select private.project_ids_with('finance.invoice.write'))$$);

-- Function privileges -----------------------------------------------------------------------------------------------------------

revoke all on function private.guard_tax_rate() from public, anon, authenticated;
revoke all on function private.guard_expense() from public, anon, authenticated;
revoke all on function private.guard_contingency_draw() from public, anon, authenticated;
revoke all on function private.guard_change_order() from public, anon, authenticated;
revoke all on function private.guard_change_order_line() from public, anon, authenticated;
revoke all on function private.guard_invoice() from public, anon, authenticated;
revoke all on function private.guard_invoice_line() from public, anon, authenticated;
revoke all on function private.guard_payment() from public, anon, authenticated;
revoke all on function private.guard_payment_application() from public, anon, authenticated;

revoke all on function app.approve_expense(uuid, text) from public, anon;
revoke all on function app.reject_expense(uuid, text) from public, anon;
revoke all on function app.transition_expense(uuid, app.expense_state, app.expense_state, text) from public, anon;
revoke all on function app.price_change_order(uuid, text) from public, anon;
revoke all on function app.approve_change_order(uuid, text) from public, anon;
revoke all on function app.transition_change_order(uuid, app.change_order_state, app.change_order_state, text) from public, anon;
revoke all on function app.issue_invoice(uuid, text) from public, anon;
revoke all on function app.approve_invoice(uuid, text) from public, anon;
revoke all on function app.transition_invoice(uuid, app.invoice_state, app.invoice_state, text) from public, anon;
revoke all on function app.approve_payment(uuid, text) from public, anon;
revoke all on function app.cancel_payment(uuid, text) from public, anon;

grant execute on function app.approve_expense(uuid, text) to authenticated, service_role;
grant execute on function app.reject_expense(uuid, text) to authenticated, service_role;
grant execute on function app.transition_expense(uuid, app.expense_state, app.expense_state, text) to authenticated, service_role;
grant execute on function app.price_change_order(uuid, text) to authenticated, service_role;
grant execute on function app.approve_change_order(uuid, text) to authenticated, service_role;
grant execute on function app.transition_change_order(uuid, app.change_order_state, app.change_order_state, text) to authenticated, service_role;
grant execute on function app.issue_invoice(uuid, text) to authenticated, service_role;
grant execute on function app.approve_invoice(uuid, text) to authenticated, service_role;
grant execute on function app.transition_invoice(uuid, app.invoice_state, app.invoice_state, text) to authenticated, service_role;
grant execute on function app.approve_payment(uuid, text) to authenticated, service_role;
grant execute on function app.cancel_payment(uuid, text) to authenticated, service_role;
