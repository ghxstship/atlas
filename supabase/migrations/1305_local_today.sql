-- 1305_local_today.sql
-- A71 (RRR-116): "today" on the project's or the org's calendar, never the database's UTC date.
-- The database runs in UTC, so current_date is a day ahead every evening in the Americas: after 20:00 in New
-- York an invoice issued, approved or self-billed was dated tomorrow, and on the last evening of a month it
-- posted into the next month's accounting period (refused when that period is not open yet). Billing already
-- counts days on the project's calendar (1122), so the dates it writes now follow the same calendar:
--   * private.zone_date(instant, zone) and private.zone_today(zone): the calendar date of an instant, or of
--     now, in an IANA zone (UTC for a blank or unknown zone)
--   * private.project_today(project): the date in the project's time zone (app.projects.time_zone)
--   * private.org_time_zone(org) and private.org_today(org): the org's locale.time_zone setting, UTC unset
--   * app.issue_invoice dates a receivable on the project's date, and private.post_invoice posts an undated
--     payable on it; app.generate_self_billed_invoice issues on it, like the timesheet days it bills
--   * private.reversal_date falls back to the org's date, the calendar of its accounting periods
-- Views call the helpers as their reader, so authenticated may execute them; it has no usage on schema private,
-- so nobody calls them directly.

create or replace function private.zone_date(p_at timestamptz, p_time_zone text)
returns date
language plpgsql
stable
set search_path = ''
as $$
begin
  return (p_at at time zone coalesce(nullif(btrim(p_time_zone), ''), 'UTC'))::date;
exception when invalid_parameter_value then
  return (p_at at time zone 'UTC')::date;
end;
$$;

comment on function private.zone_date(timestamptz, text) is 'The calendar date of an instant in an IANA time zone; UTC for a blank or unknown zone (A71).';
revoke all on function private.zone_date(timestamptz, text) from public, anon;
grant execute on function private.zone_date(timestamptz, text) to authenticated, service_role;

create or replace function private.zone_today(p_time_zone text)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select private.zone_date(pg_catalog.now(), p_time_zone);
$$;

comment on function private.zone_today(text) is 'The calendar date right now in an IANA time zone; UTC for a blank or unknown zone (A71). Use it, never current_date, wherever a date belongs to a place.';
revoke all on function private.zone_today(text) from public, anon;
grant execute on function private.zone_today(text) to authenticated, service_role;

create or replace function private.project_today(p_project_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select private.zone_today((select p.time_zone from app.projects p where p.id = p_project_id));
$$;

comment on function private.project_today(uuid) is 'Today on the project''s calendar (app.projects.time_zone), the calendar billing counts days on (A71).';
revoke all on function private.project_today(uuid) from public, anon;
grant execute on function private.project_today(uuid) to authenticated, service_role;

create or replace function private.org_time_zone(p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select v.value_text from app.setting_values v
    where v.setting_key = 'locale.time_zone' and v.scope_kind = 'Organization' and v.scope_id = p_org_id
      and v.deleted_at is null), 'UTC');
$$;

comment on function private.org_time_zone(uuid) is 'The org''s time zone: its Organization-level locale.time_zone setting (Section 4.5.6 item 35, journey 63), UTC when unset (A71).';
revoke all on function private.org_time_zone(uuid) from public, anon;
grant execute on function private.org_time_zone(uuid) to authenticated, service_role;

create or replace function private.org_today(p_org_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select private.zone_today(private.org_time_zone(p_org_id));
$$;

comment on function private.org_today(uuid) is 'Today on the org''s calendar (private.org_time_zone), the calendar of its accounting periods and org-wide deadlines (A71).';
revoke all on function private.org_today(uuid) from public, anon;
grant execute on function private.org_today(uuid) to authenticated, service_role;

-- Invoices: issued, posted and self-billed on the project's date -------------------------------------------------

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
    update app.invoices set issued_on = private.project_today(v_invoice.project_id) where id = p_invoice_id;
  end if;
  return private.transition_lifecycle('invoice', 'app.invoices', 'invoice_state', 'app.invoice_state_transitions',
    'invoice_id', p_invoice_id, 'Proposed', 'Issued', p_reason);
end;
$$;

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
  else private.org_today(p_org_id) end;
$$;

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

create or replace function app.generate_self_billed_invoice(p_engagement_id uuid, p_period_start date, p_period_end date)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_enabled boolean;
  v_invoice uuid;
  v_line uuid;
  v_number integer := 0;
  v_urid text;
  v_currency text;
  v_time_zone text;
  r record;
begin
  perform private.require_person();
  select e.* into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null or not private.can_on_project(v_engagement.project_id, 'finance.invoice.write') then
    raise exception using errcode = '42501', message = 'finance.invoice.write is required on the project';
  end if;
  select s.value_boolean into v_enabled
  from app.resolve_settings(v_engagement.org_id, v_engagement.project_id) s where s.setting_key = 'finance.self_billing_enabled';
  if v_enabled is not true then
    perform private.refuse('self_billing_disabled', 'Self-billing is off for this project; turn it on in Legal Entities and Fiscal settings first.');
  end if;
  if not exists (select 1 from app.self_billing_agreements a
                 where a.engagement_id = p_engagement_id and a.revoked_at is null and a.deleted_at is null) then
    perform private.refuse('self_billing_not_agreed', 'The party has not agreed to self-billing on this engagement; they agree in Gateway.');
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    perform private.refuse('self_billing_period', 'Choose a period whose end is on or after its start.');
  end if;
  v_currency := coalesce(v_engagement.currency_code,
    (select s.value_text from app.resolve_settings(v_engagement.org_id) s where s.setting_key = 'org.base_currency'));
  if v_currency is null then
    perform private.refuse('self_billing_currency', 'The engagement has no currency; set its rate and currency first.');
  end if;
  select d.disc_code into v_urid from xpms.role ro join xpms.dim_discipline d on d.disc_code = left(ro.role_code, 7)
  where ro.role_code = v_engagement.role_code;
  select p.time_zone into v_time_zone from app.projects p where p.id = v_engagement.project_id;

  for r in
    select 'timesheet' as source, t.id, t.period_start as sort_on,
      format('Approved timesheet %s to %s.', t.period_start, t.period_end) as description,
      case when v_engagement.pay_basis = 'Day Rate' then
        (select count(distinct (te.clock_in at time zone v_time_zone)::date) from app.time_entries te
         where te.engagement_id = t.engagement_id and te.deleted_at is null and te.clock_out is not null
           and (te.clock_in at time zone v_time_zone)::date between t.period_start and t.period_end)::numeric
      else round(coalesce(h.worked_minutes, 0)::numeric / 60, 2) end as quantity,
      case when v_engagement.pay_basis in ('Hourly', 'Day Rate') then v_engagement.agreed_rate_minor end as unit_price_minor
    from app.timesheets t
    join app.timesheet_hours h on h.timesheet_id = t.id
    where t.engagement_id = p_engagement_id and t.deleted_at is null and t.timesheet_state = 'Approved'
      and t.period_start >= p_period_start and t.period_end <= p_period_end
      and not exists (
        select 1 from app.self_billed_timesheets b
        join app.invoice_lines l on l.id = b.invoice_line_id
        join app.invoices i on i.id = l.invoice_id
        where b.timesheet_id = t.id and l.deleted_at is null and i.deleted_at is null and i.invoice_state <> 'Canceled')
    union all
    select 'deliverable', d.id, (d.decided_at at time zone v_time_zone)::date,
      format('Accepted milestone: %s.', rtrim(rec.title, '.')), 1::numeric, d.fee_minor
    from app.engagement_deliverables d
    join app.records rec on rec.id = d.record_id
    where d.engagement_id = p_engagement_id and d.deleted_at is null and d.deliverable_state = 'Accepted'
      and (d.decided_at at time zone v_time_zone)::date between p_period_start and p_period_end
      and not exists (
        select 1 from app.self_billed_deliverables b
        join app.invoice_lines l on l.id = b.invoice_line_id
        join app.invoices i on i.id = l.invoice_id
        where b.engagement_deliverable_id = d.id and l.deleted_at is null and i.deleted_at is null and i.invoice_state <> 'Canceled')
    order by 3, 1
  loop
    if v_invoice is null then
      insert into app.invoices (org_id, project_id, direction, counterparty_id, payee_person_id, engagement_id, invoice_number, issued_on, currency_code)
      values (v_engagement.org_id, v_engagement.project_id, 'Payable', v_engagement.counterparty_id,
              case when v_engagement.counterparty_id is null then v_engagement.person_id end, v_engagement.id,
              format('SB-%s-%s', to_char(p_period_end, 'YYYYMMDD'), left(replace(p_engagement_id::text, '-', ''), 8)),
              private.project_today(v_engagement.project_id), v_currency)
      returning id into v_invoice;
    end if;
    v_number := v_number + 1;
    insert into app.invoice_lines (org_id, invoice_id, line_number, description, quantity, unit_price_minor, urid)
    values (v_engagement.org_id, v_invoice, v_number, left(r.description, 500), r.quantity, r.unit_price_minor, v_urid)
    returning id into v_line;
    if r.source = 'timesheet' then
      insert into app.self_billed_timesheets (org_id, invoice_line_id, timesheet_id) values (v_engagement.org_id, v_line, r.id);
    else
      insert into app.self_billed_deliverables (org_id, invoice_line_id, engagement_deliverable_id) values (v_engagement.org_id, v_line, r.id);
    end if;
  end loop;

  if v_invoice is null then
    perform private.refuse('self_billing_nothing_to_bill', 'No approved timesheets or accepted milestones in this period are waiting to be billed.');
  end if;
  perform private.emit_event(v_engagement.org_id, 'invoice.self_billed', 'invoices', v_invoice, v_engagement.project_id,
    jsonb_build_object('engagement_id', p_engagement_id, 'line_count', v_number));
  return v_invoice;
end;
$$;

comment on function app.issue_invoice(uuid, text) is 'Issues a fully priced receivable invoice (emits invoice.issued), dated today on the project''s calendar when it has no issue date (A71). Needs finance.invoice.write on the project.';

comment on function private.reversal_date(uuid, text, uuid) is 'Date a reversing entry is recognized: the original posting date while its period still accepts postings, otherwise today on the org''s calendar (invariant 13; A71).';

comment on function private.post_invoice(uuid, boolean) is 'Posts an invoice to the journal, or reverses its posting. Receivable: Accounts Receivable debited with the total, earning class revenue and Sales Tax Payable credited per line. Payable: class expense debited per line including tax, Accounts Payable credited. Dated issued_on (today on the project''s calendar when unset; A71); a reversal is dated by private.reversal_date. Refuses a line without a price, a URID or a resolvable account, and a missing or closed period. Posts at most once per standing posting.';

comment on function app.generate_self_billed_invoice(uuid, date, date) is 'Section 4.4.5 self-billing: generates a Proposed payable invoice for the engaged party (its account, or the person engaged as an individual) with one line per approved timesheet in the period and per milestone accepted in it, each not already billed, issued today on the project''s calendar (A71). Needs finance.invoice.write on the project, the finance.self_billing_enabled setting and a live self_billing_agreements row. Hourly engagements bill worked hours and Day Rate engagements worked days at the agreed rate; milestones bill their fee; anything else bills unpriced for the org to price before approval (Section 3.7). Returns the invoice id.';
