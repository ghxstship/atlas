-- 0362_invoice_payroll_postings.sql
-- A03 Domain Data (RRR-71, ADR 0016 decision 9). Invoice and payroll postings to the journal, and so to
-- the Universal Posting Line (Section 3.11, app.posting_lines). Expenses already post on approval (0321);
-- this migration posts the other two money documents the same way:
--   * a receivable invoice posts when it is Issued: Accounts Receivable (1100) debited with the total,
--     each line's earning class revenue account credited, and tax credited to Sales Tax Payable (2300)
--   * a payable invoice posts when it is fully Approved: each line's class expense account debited with
--     the line amount and its tax, Accounts Payable (2000) credited with the total
--   * a payroll run posts when it is fully Approved: labor expense per role class and cost center
--     debited, Accrued Liabilities (2100) credited. Lines are summed per role and cost center, so the
--     ledger never shows one person's pay (the rate stays Restricted, Section 8.3).
--   * a posted document that is later Canceled posts one reversing entry
-- Postings are prepared by the platform and posted in the same statement as the transition, by the
-- person who caused it. A posting into a missing or Closed, Audited or Archived period refuses the
-- transition itself (invariant 13). Each document posts at most once: the posted entries of a source
-- alternate posting and reversal, so a re-approval after a dispute never posts twice.
-- GL accounts are resolved from the URID class (decision D13): an invoice line takes its own URID or its
-- budget line's; a payroll line takes its canon role, whose class is the department class.

-- Invoice lines: dimension 2 ------------------------------------------------------------------------------

alter table app.invoice_lines add column urid text;
create index invoice_lines_urid_idx on app.invoice_lines (urid);
comment on column app.invoice_lines.urid is 'Dimension 2: canon discipline or category the line bills or is billed for, when it has no budget line or differs from it. Its class decides the revenue or expense account the line posts to.';

create or replace function private.guard_invoice_line_urid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_urid(new.urid);
  return new;
end;
$$;

comment on function private.guard_invoice_line_urid() is 'Invoice lines: dimension 2 is a canon discipline or category.';
revoke all on function private.guard_invoice_line_urid() from public, anon, authenticated;

create trigger t41_guard_invoice_line_urid before insert or update of urid on app.invoice_lines
  for each row execute function private.guard_invoice_line_urid();

-- Payroll lines: role and cost center ------------------------------------------------------------------------

alter table app.payroll_lines
  add column role_code text references xpms.role (role_code),
  add column cost_center_id uuid references app.cost_centers (id);
create index payroll_lines_role_code_idx on app.payroll_lines (role_code);
create index payroll_lines_cost_center_id_idx on app.payroll_lines (cost_center_id);
comment on column app.payroll_lines.role_code is 'Canon role the hours were worked in. Its class decides the labor expense account; required before a run with pay posts.';
comment on column app.payroll_lines.cost_center_id is 'Dimension 1 cost center the labor posts to; NULL posts without one.';

call private.install_tenant_guards('app.payroll_lines', 'app.payroll_runs', 'payroll_run_id',
  array['app.memberships', 'membership_id', 'app.earning_codes', 'earning_code_id', 'app.cost_centers', 'cost_center_id']);

grant select (role_code, cost_center_id) on app.payroll_lines to authenticated;

create or replace view app.payroll_line_amounts as
select l.id, l.org_id, l.payroll_run_id, l.membership_id, l.earning_code_id, l.hours,
  case when private.has_capability(l.org_id, 'data.restricted.read.payroll') then l.rate_minor end as rate_minor,
  case when private.has_capability(l.org_id, 'data.restricted.read.payroll') then private.extended_minor(l.hours, l.rate_minor) end as amount_minor,
  not private.has_capability(l.org_id, 'data.restricted.read.payroll') as is_masked,
  l.role_code, l.cost_center_id
from app.payroll_lines l
where l.deleted_at is null
  and (l.org_id in (select private.orgs_with_capability('crew.pay_period.manage')) or l.org_id in (select private.orgs_with_capability('crew.payroll.export')));

comment on column app.payroll_line_amounts.role_code is 'Canon role worked.';
comment on column app.payroll_line_amounts.cost_center_id is 'Cost center the labor posts to.';

-- Shared posting helpers ---------------------------------------------------------------------------------------

create or replace function private.posting_state(p_source_table text, p_source_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from app.journal_entries e
  where e.source_table = p_source_table and e.source_id = p_source_id and e.journal_state = 'Posted' and e.deleted_at is null;
$$;

comment on function private.posting_state(text, uuid) is 'Number of posted entries a source document generated. Postings and reversals alternate, so an odd count means the document stands posted and an even count means it does not.';
revoke all on function private.posting_state(text, uuid) from public, anon, authenticated;

create or replace function private.reversal_date(p_org_id uuid, p_source_table text, p_source_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select case when exists (
    select 1 from app.accounting_periods p
    where p.org_id = p_org_id and p.deleted_at is null and p.period_state not in ('Closed', 'Audited', 'Archived')
      and (select e.entry_date from app.journal_entries e
           where e.source_table = p_source_table and e.source_id = p_source_id and e.journal_state = 'Posted'
           order by e.posted_at desc limit 1) between p.starts_on and p.ends_on)
  then (select e.entry_date from app.journal_entries e
        where e.source_table = p_source_table and e.source_id = p_source_id and e.journal_state = 'Posted'
        order by e.posted_at desc limit 1)
  else current_date end;
$$;

comment on function private.reversal_date(uuid, text, uuid) is 'Date a reversing entry is recognized: the original posting date while its period still accepts postings, otherwise today (invariant 13).';
revoke all on function private.reversal_date(uuid, text, uuid) from public, anon, authenticated;

create or replace function private.open_system_entry(p_org_id uuid, p_project_id uuid, p_entry_date date, p_memo text,
  p_source_table text, p_source_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry uuid;
begin
  perform private.begin_trusted_operation('system_journal');
  insert into app.journal_entries (accounting_period_id, project_id, entry_date, memo, source_table, source_id)
  values (private.postable_period(p_org_id, p_entry_date), p_project_id, p_entry_date, p_memo, p_source_table, p_source_id)
  returning id into v_entry;
  perform private.end_trusted_operation('system_journal');
  return v_entry;
end;
$$;

comment on function private.open_system_entry(uuid, uuid, date, text, text, uuid) is 'Prepares a platform journal entry for an approved document in the period covering its date; refuses a missing or closed period (invariant 13).';
revoke all on function private.open_system_entry(uuid, uuid, date, text, text, uuid) from public, anon, authenticated;

-- Invoice posting ------------------------------------------------------------------------------------------------

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
                 else coalesce(v_inv.issued_on, current_date) end;

  for v_line in
    select l.id, l.description, coalesce(l.urid, bl.urid) as urid, bl.cost_center_id,
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
    v_account := private.gl_account_for(v_line.urid, case when v_receivable then 'Revenue' else 'Expense' end);
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

comment on function private.post_invoice(uuid, boolean) is 'Posts an invoice to the journal, or reverses its posting. Receivable: Accounts Receivable debited with the total, earning class revenue and Sales Tax Payable credited per line. Payable: class expense debited per line including tax, Accounts Payable credited. Dated issued_on (today when unset); a reversal is dated by private.reversal_date. Refuses a line without a price, a URID or a resolvable account, and a missing or closed period. Posts at most once per standing posting.';
revoke all on function private.post_invoice(uuid, boolean) from public, anon, authenticated;

create or replace function private.post_invoice_on_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_direction app.money_direction := (select i.direction from app.invoices i where i.id = new.invoice_id);
begin
  if (new.to_state = 'Issued' and v_direction = 'Receivable') or (new.to_state = 'Approved' and v_direction = 'Payable') then
    perform private.post_invoice(new.invoice_id, false);
  elsif new.to_state = 'Canceled' then
    perform private.post_invoice(new.invoice_id, true);
  end if;
  return null;
end;
$$;

comment on function private.post_invoice_on_transition() is 'After insert on the invoice ledger: posts a receivable invoice when Issued and a payable invoice when Approved, and reverses a posted invoice when it is Canceled.';
revoke all on function private.post_invoice_on_transition() from public, anon, authenticated;

create trigger t85_post_invoice after insert on app.invoice_state_transitions
  for each row when (new.from_state is not null)
  execute function private.post_invoice_on_transition();

-- Payroll posting --------------------------------------------------------------------------------------------------

create or replace function private.post_payroll_run(p_payroll_run_id uuid, p_reverse boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.payroll_runs;
  v_posted integer := private.posting_state('payroll_runs', p_payroll_run_id);
  v_entry uuid;
  v_date date;
  v_group record;
  v_number integer := 0;
  v_total bigint := 0;
  v_account text;
begin
  if (not p_reverse and v_posted % 2 = 1) or (p_reverse and v_posted % 2 = 0) then
    return null;
  end if;
  select * into v_run from app.payroll_runs r where r.id = p_payroll_run_id;
  if exists (select 1 from app.payroll_lines l where l.payroll_run_id = p_payroll_run_id and l.deleted_at is null
             and l.role_code is null and private.extended_minor(l.hours, l.rate_minor) > 0) then
    perform private.refuse('payroll_line_role_missing', 'Give every paid payroll line its canon role before the run posts.');
  end if;
  v_date := case when p_reverse then private.reversal_date(v_run.org_id, 'payroll_runs', p_payroll_run_id)
                 else (select p.ends_on from app.pay_periods p where p.id = v_run.pay_period_id) end;

  for v_group in
    select l.role_code, l.cost_center_id, r.job_title, sum(private.extended_minor(l.hours, l.rate_minor))::bigint as amount_minor
    from app.payroll_lines l
    left join xpms.role r on r.role_code = l.role_code
    where l.payroll_run_id = p_payroll_run_id and l.deleted_at is null and private.extended_minor(l.hours, l.rate_minor) > 0
    group by l.role_code, l.cost_center_id, r.job_title
    order by l.role_code, l.cost_center_id
  loop
    v_account := private.gl_account_for(v_group.role_code, 'Expense');
    if v_account is null then
      perform private.refuse('gl_account_unresolved', format('No labor expense account resolves for role %s.', v_group.role_code));
    end if;
    if v_entry is null then
      v_entry := private.open_system_entry(v_run.org_id, null, v_date,
        case when p_reverse then 'Reversal of payroll run.' else 'Payroll run.' end, 'payroll_runs', p_payroll_run_id);
    end if;
    v_number := v_number + 1;
    insert into app.journal_lines (journal_entry_id, line_number, account_code, cost_center_id, urid, description,
      debit_minor, credit_minor, currency_code)
    values (v_entry, v_number, v_account, v_group.cost_center_id,
      (select d.disc_code from xpms.dim_discipline d where d.disc_code = left(v_group.role_code, 7)),
      format('Payroll labor: %s.', v_group.job_title),
      case when p_reverse then 0 else v_group.amount_minor end, case when p_reverse then v_group.amount_minor else 0 end, v_run.currency_code);
    v_total := v_total + v_group.amount_minor;
  end loop;

  if v_entry is null then
    return null;
  end if;
  v_number := v_number + 1;
  insert into app.journal_lines (journal_entry_id, line_number, account_code, description, debit_minor, credit_minor, currency_code)
  values (v_entry, v_number, '2100', 'Payroll payable.',
    case when p_reverse then v_total else 0 end, case when p_reverse then 0 else v_total end, v_run.currency_code);
  perform private.post_journal(v_entry, case when p_reverse then 'Payroll run canceled.' else 'Payroll run approved.' end);
  return v_entry;
end;
$$;

comment on function private.post_payroll_run(uuid, boolean) is 'Posts an approved payroll run to the journal, or reverses it: labor expense of each role class debited per role and cost center (never per person, so pay stays Restricted), Accrued Liabilities (2100) credited, dated the last day of the pay period. Dimension 2 is the role''s canon discipline. Refuses a paid line without a role and a missing or closed period. A run with no pay posts nothing.';
revoke all on function private.post_payroll_run(uuid, boolean) from public, anon, authenticated;

create or replace function private.post_payroll_run_on_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.to_state = 'Approved' then
    perform private.post_payroll_run(new.payroll_run_id, false);
  elsif new.to_state = 'Canceled' then
    perform private.post_payroll_run(new.payroll_run_id, true);
  end if;
  return null;
end;
$$;

comment on function private.post_payroll_run_on_transition() is 'After insert on the payroll run ledger: posts a run when it is Approved (once, even when re-approved after an export is pulled back) and reverses a posted run when it is Canceled.';
revoke all on function private.post_payroll_run_on_transition() from public, anon, authenticated;

create trigger t85_post_payroll_run after insert on app.payroll_run_state_transitions
  for each row when (new.from_state is not null)
  execute function private.post_payroll_run_on_transition();

insert into private.domain_event_types (code, subject, description) values
  ('invoice.canceled', 'invoices', 'An invoice was canceled; a posted invoice is reversed in the ledger.');

create trigger t90_emit_invoice_canceled after insert on app.invoice_state_transitions
  for each row when (new.to_state = 'Canceled')
  execute function private.emit_subject_event('invoice.canceled', 'invoices', 'invoice_id', 'from_state', 'to_state', 'reason');
