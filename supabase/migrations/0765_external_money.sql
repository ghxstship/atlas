-- 0765_external_money.sql
-- A28 Engagements and Marketplace (RRR-30), Gateway group 4 for A27 (Section 4.4.5 payments to external parties):
--   * api_external.invoices: invoices between an org and the caller's account on projects where the account's
--     engagement has the money area open (Section 8.7): payables the account billed, in every state, and
--     receivables the org issued to it, once issued. Status dates come from the invoice ledger; totals, payments
--     applied and the balance are NULL-aware (a blank price stays blank, Section 3.7)
--   * api_external.invoice_lines: the lines, without budget lines or other internal coding
--   * app.submit_engagement_invoice: the party submits a payable invoice against its engagement; it arrives
--     Proposed for the org to approve through A15's app.approve_invoice
-- Self-billing (invoices generated from approved timesheets where the org enables it and the party agrees) and
-- the timesheet and time entry projections follow with A15 and with A03F's engagement_id on time entries.

create or replace function private.money_open_for_counterparty(p_project_id uuid, p_counterparty_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagements e
    join app.counterparties c on c.id = e.counterparty_id
    where e.project_id = p_project_id and e.counterparty_id = p_counterparty_id and e.deleted_at is null
      and c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]))
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'money'));
$$;

comment on function private.money_open_for_counterparty(uuid, uuid) is 'Section 8.7: true when the signed-in person is an Account Owner, Admin or Finance member of the counterparty''s account and reaches the money area of its engagement on the project, while the engagement state and time box allow it. A person the account supplies never reads the account''s invoices. Takes the invoice''s column values.';

create or replace function private.external_invoice_total(p_invoice_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select private.invoice_total(p_invoice_id);
$$;

comment on function private.external_invoice_total(uuid) is 'Invoice total including tax for the external projection; NULL with no lines or an unpriced line.';

create view api_external.invoices as
select i.id, i.org_id, o.name as org_name, i.project_id, p.name as project_name, i.direction, c.organization_id as account_id,
  i.invoice_number, i.issued_on, i.due_on, i.currency_code, i.invoice_state,
  private.external_invoice_total(i.id) as total_minor,
  pa.applied_minor,
  case when private.external_invoice_total(i.id) is not null then private.external_invoice_total(i.id) - pa.applied_minor end as balance_minor,
  i.created_at as submitted_at, ld.issued_at, ld.approved_at, ld.disputed_at, ld.canceled_at, pa.last_paid_on
from app.invoices i
join app.organizations o on o.id = i.org_id
join app.projects p on p.id = i.project_id
join app.counterparties c on c.id = i.counterparty_id
cross join lateral (
  select max(t.created_at) filter (where t.to_state = 'Issued') as issued_at,
    max(t.created_at) filter (where t.to_state = 'Approved') as approved_at,
    max(t.created_at) filter (where t.to_state = 'Disputed') as disputed_at,
    max(t.created_at) filter (where t.to_state = 'Canceled') as canceled_at
  from app.invoice_state_transitions t where t.invoice_id = i.id
) ld
cross join lateral (
  select coalesce(sum(a.amount_minor), 0)::bigint as applied_minor, max(pm.paid_on) as last_paid_on
  from app.payment_applications a join app.payments pm on pm.id = a.payment_id and pm.deleted_at is null and pm.payment_state <> 'Proposed'
  where a.invoice_id = i.id and a.deleted_at is null
) pa
where i.deleted_at is null
  and (i.direction = 'Payable' or i.invoice_state <> 'Proposed')
  and private.money_open_for_counterparty(i.project_id, i.counterparty_id);

call private.describe('api_external.invoices', 'Invoices between an org and the caller''s account (Section 4.4.5): payables the account submitted, in every state, and receivables the org issued to it, once issued. Only while the account''s engagement on the project has the money area open (Section 8.7). Totals are NULL while any line is unpriced.', array[
  'id', 'Invoice.', 'org_id', 'Org.', 'org_name', 'Org name.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'direction', 'Payable (the account bills the org) or Receivable (the org bills the account).', 'account_id', 'The caller''s account.',
  'invoice_number', 'Invoice number.', 'issued_on', 'Invoice date.', 'due_on', 'Due date.', 'currency_code', 'Currency.',
  'invoice_state', 'Invoice state.', 'total_minor', 'Total with tax in minor units; NULL while any line is unpriced.',
  'applied_minor', 'Payments applied in minor units.', 'balance_minor', 'Total less payments applied; NULL while the total is unknown.',
  'submitted_at', 'When the invoice was recorded.', 'issued_at', 'When the org issued it.', 'approved_at', 'When the org approved it for payment.',
  'disputed_at', 'When it was last disputed.', 'canceled_at', 'When it was canceled.', 'last_paid_on', 'Date of the latest payment applied.']);

create view api_external.invoice_lines as
select l.id, l.invoice_id, l.line_number, l.description, l.quantity, l.unit_price_minor,
  private.extended_minor(l.quantity, l.unit_price_minor) as amount_minor, r.rate_percent as tax_rate_percent
from app.invoice_lines l
join app.invoices i on i.id = l.invoice_id and i.deleted_at is null
left join app.tax_rates r on r.id = l.tax_rate_id
where l.deleted_at is null
  and (i.direction = 'Payable' or i.invoice_state <> 'Proposed')
  and private.money_open_for_counterparty(i.project_id, i.counterparty_id);

call private.describe('api_external.invoice_lines', 'Lines of the caller''s invoices. Budget lines and other internal coding never appear.', array[
  'id', 'Line.', 'invoice_id', 'Invoice.', 'line_number', 'Order.', 'description', 'What is billed.', 'quantity', 'Quantity.',
  'unit_price_minor', 'Unit price in minor units; NULL is unpriced.', 'amount_minor', 'Quantity times unit price; NULL when unpriced.',
  'tax_rate_percent', 'Tax rate applied, when taxed.']);

-- Party submission ---------------------------------------------------------------------------------------------------------

create or replace function app.submit_engagement_invoice(
  p_engagement_id uuid,
  p_invoice_number text,
  p_issued_on date,
  p_due_on date,
  p_currency_code text,
  p_lines jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_invoice uuid;
  v_line jsonb;
  v_number integer := 0;
begin
  perform private.require_person();
  select e.* into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null
     or not private.engagement_area_open(v_engagement.id, v_engagement.person_id, v_engagement.counterparty_id, v_engagement.role_type,
                                         v_engagement.engagement_state, 'money') then
    raise exception using errcode = '42501', message = 'the money area of this engagement is not open to the caller';
  end if;
  if v_engagement.counterparty_id is null then
    perform private.refuse('invoice_needs_account', 'Invoices come from an external account; add your business account to the engagement first.');
  end if;
  if v_engagement.counterparty_id not in (
      select c.id from app.counterparties c
      where c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]))) then
    raise exception using errcode = '42501', message = 'an Account Owner, Admin or Finance member submits the account''s invoices';
  end if;
  if p_invoice_number is null or char_length(btrim(p_invoice_number)) not between 1 and 60 then
    perform private.refuse('invoice_number_required', 'Give the invoice your own invoice number.');
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    perform private.refuse('invoice_lines_required', 'An invoice needs at least one line.');
  end if;
  insert into app.invoices (project_id, direction, counterparty_id, invoice_number, issued_on, due_on, currency_code)
  values (v_engagement.project_id, 'Payable', v_engagement.counterparty_id, btrim(p_invoice_number), p_issued_on, p_due_on, p_currency_code)
  returning id into v_invoice;
  for v_line in select x from jsonb_array_elements(p_lines) x loop
    v_number := v_number + 1;
    insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor)
    values (v_invoice, v_number, v_line ->> 'description', coalesce((v_line ->> 'quantity')::numeric, 1), (v_line ->> 'unit_price_minor')::bigint);
  end loop;
  return v_invoice;
end;
$$;

comment on function app.submit_engagement_invoice(uuid, text, date, date, text, jsonb) is 'The engaged account (Owner, Admin or Finance) submits a payable invoice against its engagement while the money area is open (Section 4.4.5). Lines are an array of {description, quantity, unit_price_minor}; a missing price stays unpriced. The invoice arrives Proposed for the org to approve. Returns the invoice id.';

-- Privileges ------------------------------------------------------------------------------------------------------------------

revoke all on function private.money_open_for_counterparty(uuid, uuid) from public, anon;
revoke all on function private.external_invoice_total(uuid) from public, anon;
grant execute on function private.money_open_for_counterparty(uuid, uuid) to authenticated, service_role;
grant execute on function private.external_invoice_total(uuid) to authenticated, service_role;
revoke all on function app.submit_engagement_invoice(uuid, text, date, date, text, jsonb) from public, anon;
grant execute on function app.submit_engagement_invoice(uuid, text, date, date, text, jsonb) to authenticated, service_role;

revoke all on api_external.invoices, api_external.invoice_lines from public, anon;
grant select on api_external.invoices, api_external.invoice_lines to authenticated, service_role;
