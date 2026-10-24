-- 1611_gl_explicit_defaults.sql
-- WP18 (range 1610 to 1619; RRR-66). Owner decision 39 (2026-10-23, canon/rulings/decision-39.yaml) reads ruling
-- D13 (GL accounts derived by class) as allowing explicit GL defaults on an item and on a counterparty type. A
-- posting now takes:
--   1. the item's explicit account, when the line prices a catalog element that carries one: its purchase account
--      for an expense, its sales account for revenue. A balance-sheet item, which no class can derive, posts here;
--   2. else the account of the URID's class (private.gl_account_for, unchanged);
--   3. else the default account of the counterparty's type, when the class gives no account of the type and that
--      default is one (a receivable to a Sponsor under a class with no revenue account).
-- Items whose explicit account is their class's (all but five) post exactly as before. Recreated from their latest
-- definitions with only the account lookup changed: app.approve_expense (0321), private.post_invoice (1305) and the
-- views app.budget_line_amounts (0321) and app.change_order_line_facts (0480), which report the account a line posts
-- to. app.budget_line_facts (0480) reads its account from budget_line_amounts; only its comment changes.
-- A budget line's item prices an invoice or change order line only while that line keeps the budget line's URID: a
-- line naming a URID of its own (app.invoice_lines.urid, 0362) bills something else and posts by that URID's class.
-- The comments on app.budget_lines (0320) and app.invoice_lines.urid (0362), which said the class alone decides the
-- account, are restated.

create or replace function private.gl_account_for_line(
  p_urid text,
  p_account_type text,
  p_element_id text default null,
  p_counterparty_id uuid default null
)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select case p_account_type when 'Revenue' then e.sales_account when 'Expense' then e.purchase_account end
       from xpms.elements e where e.element_id = p_element_id),
    private.gl_account_for(p_urid, p_account_type),
    (select t.default_account_code from app.counterparties c
       join xpms.dim_counterparty_type t on t.counterparty_type = c.counterparty_type
       join xpms.dim_gl_account a on a.account_code = t.default_account_code
      where c.id = p_counterparty_id and a.account_type = p_account_type));
$$;

comment on function private.gl_account_for_line(text, text, text, uuid) is 'Decision D13 as owner decision 39 reads it: the account a line posts to. The priced item''s explicit GL default first (purchase account for Expense, sales account for Revenue), else its URID class''s one account of the type (private.gl_account_for), else the default account of the counterparty''s type when it is of the type. NULL when none resolves.';
revoke all on function private.gl_account_for_line(text, text, text, uuid) from public, anon;
grant execute on function private.gl_account_for_line(text, text, text, uuid) to authenticated, service_role;

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
  v_account := private.gl_account_for_line(v_line.urid, 'Expense', v_line.element_id, v_expense.counterparty_id);
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

comment on function app.approve_expense(uuid, text) is 'Approves a submitted expense: needs finance.expense.approve on the project, refuses the submitter (sod_expense_submitter), applies spend authority (two approvers above the dual threshold), then moves it to Approved and posts it to the line''s expense account (private.gl_account_for_line: the item''s explicit GL default, else the class expense account, else the counterparty type''s default) against Accounts Payable in the period covering incurred_on (invariant 13). Returns true once fully approved.';
revoke all on function app.approve_expense(uuid, text) from public, anon;
grant execute on function app.approve_expense(uuid, text) to authenticated, service_role;

create or replace function private.post_invoice(p_invoice_id uuid, p_reverse boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv app.invoices;
  v_receivable boolean;
  v_posted integer := private.posting_state('invoices', p_invoice_id);
  v_entry uuid;
  v_date date;
  v_line record;
  v_number integer := 0;
  v_total bigint := 0;
  v_account text;
  v_control text;
begin
  if (not p_reverse and v_posted % 2 = 1) or (p_reverse and v_posted % 2 = 0) then
    return null;
  end if;
  select * into v_inv from app.invoices i where i.id = p_invoice_id;
  v_receivable := v_inv.direction = 'Receivable';
  v_control := case when v_receivable then '1100' else '2000' end;
  v_date := case when p_reverse then private.reversal_date(v_inv.org_id, 'invoices', p_invoice_id)
                 else coalesce(v_inv.issued_on, private.project_today(v_inv.project_id)) end;

  -- The budget line's item prices the line only while the line keeps the budget line's URID; a line naming a URID of
  -- its own bills something else and posts by that URID's class.
  for v_line in
    select l.id, l.description, coalesce(l.urid, bl.urid) as urid, bl.cost_center_id,
      case when l.urid is null or l.urid = bl.urid then bl.element_id end as element_id,
      private.extended_minor(l.quantity, l.unit_price_minor) as amount_minor,
      coalesce(round(private.extended_minor(l.quantity, l.unit_price_minor) * r.rate_percent / 100)::bigint, 0) as tax_minor
    from app.invoice_lines l
    left join app.budget_lines bl on bl.id = l.budget_line_id
    left join app.tax_rates r on r.id = l.tax_rate_id
    where l.invoice_id = p_invoice_id and l.deleted_at is null
    order by l.line_number
  loop
    if v_line.amount_minor is null then
      perform private.refuse('invoice_unpriced', 'Every line of an invoice needs a price before it posts.');
    end if;
    if v_line.urid is null then
      perform private.refuse('invoice_line_dimension_missing', 'Give every invoice line a URID or a budget line before it posts.');
    end if;
    v_account := private.gl_account_for_line(v_line.urid, case when v_receivable then 'Revenue' else 'Expense' end,
      v_line.element_id, v_inv.counterparty_id);
    if v_account is null then
      perform private.refuse('gl_account_unresolved',
        format('No %s account resolves for %s; bill revenue under an earning class.', case when v_receivable then 'revenue' else 'expense' end, v_line.urid));
    end if;
    if v_entry is null and (v_line.amount_minor + v_line.tax_minor) > 0 then
      v_entry := private.open_system_entry(v_inv.org_id, v_inv.project_id, v_date,
        format('%s%s invoice %s.', case when p_reverse then 'Reversal of ' else '' end,
          case when v_receivable then 'Receivable' else 'Payable' end, coalesce(v_inv.invoice_number, v_inv.id::text)),
        'invoices', p_invoice_id);
    end if;
    -- Receivables credit revenue and tax; payables debit expense including tax. A reversal swaps sides.
    if v_receivable then
      if v_line.amount_minor > 0 then
        v_number := v_number + 1;
        insert into app.journal_lines (journal_entry_id, line_number, account_code, cost_center_id, urid, counterparty_id,
          description, debit_minor, credit_minor, currency_code)
        values (v_entry, v_number, v_account, v_line.cost_center_id, v_line.urid, v_inv.counterparty_id, v_line.description,
          case when p_reverse then v_line.amount_minor else 0 end, case when p_reverse then 0 else v_line.amount_minor end, v_inv.currency_code);
      end if;
      if v_line.tax_minor > 0 then
        v_number := v_number + 1;
        insert into app.journal_lines (journal_entry_id, line_number, account_code, cost_center_id, urid, counterparty_id,
          description, debit_minor, credit_minor, currency_code)
        values (v_entry, v_number, '2300', v_line.cost_center_id, v_line.urid, v_inv.counterparty_id, v_line.description,
          case when p_reverse then v_line.tax_minor else 0 end, case when p_reverse then 0 else v_line.tax_minor end, v_inv.currency_code);
      end if;
    elsif (v_line.amount_minor + v_line.tax_minor) > 0 then
      v_number := v_number + 1;
      insert into app.journal_lines (journal_entry_id, line_number, account_code, cost_center_id, urid, counterparty_id,
        description, debit_minor, credit_minor, currency_code)
      values (v_entry, v_number, v_account, v_line.cost_center_id, v_line.urid, v_inv.counterparty_id, v_line.description,
        case when p_reverse then 0 else v_line.amount_minor + v_line.tax_minor end,
        case when p_reverse then v_line.amount_minor + v_line.tax_minor else 0 end, v_inv.currency_code);
    end if;
    v_total := v_total + v_line.amount_minor + v_line.tax_minor;
  end loop;

  if v_entry is null then
    return null;
  end if;
  v_number := v_number + 1;
  insert into app.journal_lines (journal_entry_id, line_number, account_code, counterparty_id, description, debit_minor, credit_minor, currency_code)
  values (v_entry, v_number, v_control, v_inv.counterparty_id,
    case when v_receivable then 'Accounts receivable.' else 'Accounts payable.' end,
    case when v_receivable <> p_reverse then v_total else 0 end, case when v_receivable <> p_reverse then 0 else v_total end, v_inv.currency_code);
  perform private.post_journal(v_entry, case when p_reverse then 'Invoice canceled.' when v_receivable then 'Invoice issued.' else 'Invoice approved.' end);
  return v_entry;
end;
$$;

comment on function private.post_invoice(uuid, boolean) is 'Posts an invoice to the journal, or reverses its posting. Receivable: Accounts Receivable debited with the total, each line''s revenue account and Sales Tax Payable credited per line. Payable: each line''s expense account debited including tax, Accounts Payable credited. A line''s account is private.gl_account_for_line: the explicit GL default of the item its budget line prices, when the line has no URID of its own or the budget line''s, else its URID''s earning or expense class account, else the counterparty type''s default (decision 39). Dated issued_on (today on the project''s calendar when unset; A71); a reversal is dated by private.reversal_date. Refuses a line without a price, a URID or a resolvable account, and a missing or closed period. Posts at most once per standing posting.';
revoke all on function private.post_invoice(uuid, boolean) from public, anon, authenticated;

create or replace view app.budget_line_amounts with (security_invoker = true) as
select bl.id as budget_line_id, bl.budget_id, bl.line_type, bl.urid,
  private.gl_account_for_line(bl.urid, 'Expense', bl.element_id) as account_code,
  private.extended_minor(bl.quantity, bl.unit_price_minor) as extended_minor,
  (bl.unit_price_minor is null) as is_unpriced,
  coalesce((select sum(d.amount_minor) from app.contingency_draws d where d.to_budget_line_id = bl.id and d.deleted_at is null), 0) as drawn_in_minor,
  coalesce((select sum(d.amount_minor) from app.contingency_draws d where d.from_budget_line_id = bl.id and d.deleted_at is null), 0) as drawn_out_minor,
  coalesce((select sum(e.amount_minor) from app.expenses e where e.budget_line_id = bl.id and e.deleted_at is null
            and e.expense_state in ('Approved', 'Paid')), 0) as actual_minor
from app.budget_lines bl
where bl.deleted_at is null;

comment on view app.budget_line_amounts is 'Budget line amounts, derived: extended amount (NULL when unpriced, never zero), contingency moved in and out, the GL account (the item''s explicit default, else by class: decision D13 as owner decision 39 reads it) and approved spend.';
comment on column app.budget_line_amounts.account_code is 'Expense account the line posts to: the priced item''s explicit GL default, else the URID class''s expense account.';
comment on column app.budget_line_facts.account_code is 'Expense account the line posts to (app.budget_line_amounts): the priced item''s explicit GL default, else the URID class''s expense account (decision D13 as owner decision 39 reads it); NULL when neither gives one.';

create or replace view app.change_order_line_facts with (security_invoker = true) as
select l.id as change_order_line_id, c.id as change_order_id, c.project_id, c.budget_id, c.change_order_state,
  l.budget_line_id, l.urid, left(l.urid, 4) as dept_code,
  private.gl_account_for_line(l.urid, 'Expense', case when bl.urid = l.urid then bl.element_id end) as account_code,
  bl.cost_center_id, private.extended_minor(l.quantity, l.unit_price_minor) as extended_minor,
  (l.unit_price_minor is null) as is_unpriced
from app.change_order_lines l
join app.change_orders c on c.id = l.change_order_id
left join app.budget_lines bl on bl.id = l.budget_line_id
where l.deleted_at is null and c.deleted_at is null;

comment on column app.change_order_line_facts.account_code is 'Expense account of the change: the explicit GL default of the item the adjusted budget line prices, when the change keeps that line''s URID, else the URID class''s expense account (decision D13 as owner decision 39 reads it).';

-- Comments that said the class alone decides the account (0320, 0362) -------------------------------------------------

comment on table app.budget_lines is 'Budget lines (Section 7.4). The unit price is NULL when unpriced and never defaulted to zero; the extended amount is derived. The GL account is derived, never stored: the priced item''s explicit GL default first, then the URID''s class account, then the counterparty type''s default (decision D13 as owner decision 39 reads it, private.gl_account_for_line).';
comment on column app.budget_lines.urid is 'Dimension 2: canon discipline or category the line spends on. Its class gives the GL account when the priced item carries no explicit GL default; the counterparty type''s default applies only when neither gives one.';
comment on column app.budget_lines.element_id is 'Catalog element priced by the line, when one applies. Its explicit GL default (purchase account) comes before the URID class''s account.';
comment on column app.invoice_lines.urid is 'Dimension 2: canon discipline or category the line bills or is billed for, when it has no budget line or differs from it. The line posts to the explicit GL default of the item its budget line prices only while this is unset or the budget line''s URID, else to this URID''s class revenue or expense account, else to the counterparty type''s default.';
