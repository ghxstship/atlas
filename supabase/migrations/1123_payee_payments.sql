-- 1123_payee_payments.sql
-- A43 (RRR-87), finding A38-007. Recording a payment, and the party's view of it in Gateway:
--   * app.record_invoice_payment: Atlas finance records that an invoice was paid (or part of it), as a
--     Proposed payment of the invoice's payee applied to the invoice. Approving it stays app.approve_payment,
--     never by the person who recorded it. Moving money is not done here: payouts run on the org's rails or
--     a provider (Section 4.4.5, 14.9), and the provider's reference is recorded with the payment.
--   * api_external.invoices and invoice_lines also show a person engaged as an individual their own
--     invoices while the engagement's money area is open, plus scheduled_minor and scheduled_on: payments
--     recorded and applied but not yet approved, the Scheduled step of the Gateway tracker.
--   * api_external.payments also shows a person the payments made to them; they never close (Section 8.7).
--   * api_external.deliverables shows each milestone's fee and currency.

create or replace function app.record_invoice_payment(
  p_invoice_id uuid,
  p_paid_on date,
  p_amount_minor bigint default null,
  p_reference text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invoice app.invoices;
  v_total bigint;
  v_applied bigint;
  v_amount bigint;
  v_payment uuid;
begin
  perform private.require_person();
  select i.* into v_invoice from app.invoices i where i.id = p_invoice_id and i.deleted_at is null;
  if v_invoice.id is null or not private.has_capability(v_invoice.org_id, 'finance.payment.write')
     or not private.can_on_project(v_invoice.project_id, 'finance.invoice.read') then
    raise exception using errcode = '42501', message = 'finance.payment.write and read access to the invoice are required';
  end if;
  if v_invoice.invoice_state not in ('Issued', 'Approved') then
    perform private.refuse('invoice_payment_state', 'Record a payment against an approved payable or an issued receivable.');
  end if;
  v_total := private.invoice_total(p_invoice_id);
  select coalesce(sum(a.amount_minor), 0) into v_applied from app.payment_applications a
  join app.payments pm on pm.id = a.payment_id and pm.payment_state <> 'Canceled' and pm.deleted_at is null
  where a.invoice_id = p_invoice_id and a.deleted_at is null;
  v_amount := coalesce(p_amount_minor, v_total - v_applied);
  if v_amount is null or v_amount <= 0 then
    perform private.refuse('invoice_payment_amount', 'Nothing is left to pay on this invoice.');
  end if;
  if p_paid_on is null then
    perform private.refuse('invoice_payment_date', 'Give the date the money moved.');
  end if;
  insert into app.payments (org_id, counterparty_id, payee_person_id, direction, amount_minor, currency_code, paid_on, reference_identifier)
  values (v_invoice.org_id, v_invoice.counterparty_id, v_invoice.payee_person_id, v_invoice.direction, v_amount,
          v_invoice.currency_code, p_paid_on, nullif(btrim(coalesce(p_reference, '')), ''))
  returning id into v_payment;
  insert into app.payment_applications (org_id, payment_id, invoice_id, amount_minor)
  values (v_invoice.org_id, v_payment, p_invoice_id, v_amount);
  return v_payment;
end;
$$;

comment on function app.record_invoice_payment(uuid, date, bigint, text) is 'Records that an approved payable (or issued receivable) was paid: a Proposed payment to or from the invoice''s payee, applied to the invoice, for the whole balance when no amount is given. Needs finance.payment.write and read access to the invoice. Money moves on the org''s rails or a payout provider; p_reference is its remittance reference. Approve the payment with app.approve_payment. Returns the payment id.';
revoke all on function app.record_invoice_payment(uuid, date, bigint, text) from public, anon;
grant execute on function app.record_invoice_payment(uuid, date, bigint, text) to authenticated, service_role;

-- Money area of a person engaged as an individual --------------------------------------------------------------

create or replace function private.money_open_for_person(p_engagement_id uuid, p_payee_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_payee_person_id = private.current_person_id() and exists (
    select 1 from app.engagements e
    where e.id = p_engagement_id and e.deleted_at is null and e.counterparty_id is null and e.person_id = p_payee_person_id
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'money'));
$$;

comment on function private.money_open_for_person(uuid, uuid) is 'Section 8.7: true when the signed-in person is the payee of an invoice on an engagement they hold as an individual, while its money area is open. Takes the invoice''s column values.';
revoke all on function private.money_open_for_person(uuid, uuid) from public, anon;
grant execute on function private.money_open_for_person(uuid, uuid) to authenticated, service_role;

-- Projections --------------------------------------------------------------------------------------------------

create or replace view api_external.invoices as
select i.id, i.org_id, o.name as org_name, i.project_id, p.name as project_name, i.direction, c.organization_id as account_id,
  i.invoice_number, i.issued_on, i.due_on, i.currency_code, i.invoice_state,
  private.external_invoice_total(i.id) as total_minor,
  pa.applied_minor,
  case when private.external_invoice_total(i.id) is not null then private.external_invoice_total(i.id) - pa.applied_minor end as balance_minor,
  i.created_at as submitted_at, ld.issued_at, ld.approved_at, ld.disputed_at, ld.canceled_at, pa.last_paid_on,
  i.payee_person_id, i.engagement_id, pa.scheduled_minor, pa.scheduled_on
from app.invoices i
join app.organizations o on o.id = i.org_id
join app.projects p on p.id = i.project_id
left join app.counterparties c on c.id = i.counterparty_id
cross join lateral (
  select max(t.created_at) filter (where t.to_state = 'Issued') as issued_at,
    max(t.created_at) filter (where t.to_state = 'Approved') as approved_at,
    max(t.created_at) filter (where t.to_state = 'Disputed') as disputed_at,
    max(t.created_at) filter (where t.to_state = 'Canceled') as canceled_at
  from app.invoice_state_transitions t where t.invoice_id = i.id
) ld
cross join lateral (
  select coalesce(sum(a.amount_minor) filter (where pm.payment_state = 'Approved'), 0)::bigint as applied_minor,
    max(pm.paid_on) filter (where pm.payment_state = 'Approved') as last_paid_on,
    coalesce(sum(a.amount_minor) filter (where pm.payment_state = 'Proposed'), 0)::bigint as scheduled_minor,
    max(pm.paid_on) filter (where pm.payment_state = 'Proposed') as scheduled_on
  from app.payment_applications a join app.payments pm on pm.id = a.payment_id and pm.deleted_at is null and pm.payment_state <> 'Canceled'
  where a.invoice_id = i.id and a.deleted_at is null
) pa
where i.deleted_at is null
  and (i.direction = 'Payable' or i.invoice_state <> 'Proposed')
  and ((i.counterparty_id is not null and private.money_open_for_counterparty(i.project_id, i.counterparty_id))
    or (i.payee_person_id is not null and private.money_open_for_person(i.engagement_id, i.payee_person_id)));

call private.describe('api_external.invoices', 'Invoices between an org and the caller''s account, or the caller as an individual (Section 4.4.5): payables the party submitted or was self-billed, in every state, and receivables the org issued to it, once issued. Only while the party''s engagement on the project has the money area open (Section 8.7). Totals are NULL while any line is unpriced.', array[
  'id', 'Invoice.', 'org_id', 'Org.', 'org_name', 'Org name.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'direction', 'Payable (the party bills the org) or Receivable (the org bills the party).', 'account_id', 'The caller''s account; NULL for an individual''s invoice.',
  'invoice_number', 'Invoice number.', 'issued_on', 'Invoice date.', 'due_on', 'Due date.', 'currency_code', 'Currency.',
  'invoice_state', 'Invoice state.', 'total_minor', 'Total with tax in minor units; NULL while any line is unpriced.',
  'applied_minor', 'Approved payments applied in minor units.', 'balance_minor', 'Total less approved payments applied; NULL while the total is unknown.',
  'submitted_at', 'When the invoice was recorded.', 'issued_at', 'When the org issued it.', 'approved_at', 'When the org approved it for payment.',
  'disputed_at', 'When it was last disputed.', 'canceled_at', 'When it was canceled.', 'last_paid_on', 'Date of the latest approved payment applied.',
  'payee_person_id', 'The caller, for an invoice billed by them as an individual.', 'engagement_id', 'Engagement the invoice bills.',
  'scheduled_minor', 'Payments recorded against it and awaiting approval, in minor units.', 'scheduled_on', 'Payment date of the latest recorded payment awaiting approval.']);

create or replace view api_external.invoice_lines as
select l.id, l.invoice_id, l.line_number, l.description, l.quantity, l.unit_price_minor,
  private.extended_minor(l.quantity, l.unit_price_minor) as amount_minor, r.rate_percent as tax_rate_percent
from app.invoice_lines l
join app.invoices i on i.id = l.invoice_id and i.deleted_at is null
left join app.tax_rates r on r.id = l.tax_rate_id
where l.deleted_at is null
  and (i.direction = 'Payable' or i.invoice_state <> 'Proposed')
  and ((i.counterparty_id is not null and private.money_open_for_counterparty(i.project_id, i.counterparty_id))
    or (i.payee_person_id is not null and private.money_open_for_person(i.engagement_id, i.payee_person_id)));

create or replace view api_external.payments as
select pm.id, pm.org_id, o.name as org_name, c.organization_id as account_id, pm.amount_minor, pm.currency_code, pm.paid_on,
  pm.reference_identifier, pm.payment_state, pm.payee_person_id
from app.payments pm
left join app.counterparties c on c.id = pm.counterparty_id
join app.organizations o on o.id = pm.org_id
where pm.deleted_at is null and pm.direction = 'Payable' and pm.payment_state <> 'Proposed'
  and ((c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]))
        and exists (select 1 from app.engagements e where e.counterparty_id = pm.counterparty_id and e.deleted_at is null))
    or (pm.payee_person_id is not null and pm.payee_person_id = private.current_person_id()));

call private.describe('api_external.payments', 'Payments an org made to the caller''s account, for its Account Owners, Admins and Finance members, or to the caller as an individual (Section 4.4.5). Payments are the party''s own records and never close.', array[
  'id', 'Payment.', 'org_id', 'Paying org.', 'org_name', 'Paying org name.', 'account_id', 'Account paid; NULL for a payment to an individual.',
  'amount_minor', 'Amount in minor units.', 'currency_code', 'Currency.', 'paid_on', 'Payment date.',
  'reference_identifier', 'Remittance reference.', 'payment_state', 'Payment state.', 'payee_person_id', 'The caller, for a payment to them as an individual.']);

create or replace view api_external.deliverables as
select d.id, d.engagement_id, d.record_id, r.record_kind, r.title, r.due_at, d.deliverable_state, d.document_id, d.submission_message,
  d.submitted_at, d.decided_at, d.return_reason, d.fee_minor, e.currency_code
from app.engagement_deliverables d
join app.records r on r.id = d.record_id and r.deleted_at is null
join app.engagements e on e.id = d.engagement_id
where d.deleted_at is null and private.deliverable_party_open(d.engagement_id);

call private.describe('api_external.deliverables', 'What the caller''s engagements owe (Section 4.4.4 Contractor), with their state, fee, the latest submission and any reason the org returned it, while the operational area is open. Who decided never appears.', array[
  'id', 'Deliverable.', 'engagement_id', 'Engagement.', 'record_id', 'Record naming what is owed.', 'record_kind', 'Record kind.',
  'title', 'What is owed.', 'due_at', 'When it is due.', 'deliverable_state', 'Open, Submitted, Accepted or Returned.',
  'document_id', 'Document handed in.', 'submission_message', 'The party''s message.', 'submitted_at', 'When handed in.',
  'decided_at', 'When accepted or returned.', 'return_reason', 'Why it was returned.',
  'fee_minor', 'Agreed fee in minor units; NULL is unpriced.', 'currency_code', 'Currency of the fee.']);
