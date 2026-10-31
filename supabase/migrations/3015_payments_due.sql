-- 3015_payments_due.sql
-- B12 (RRR-236, gap G-184; Section 3.7, ADR 0151 items 4 and 7). One ledger of what an org owes and when: payable
-- bills, purchase order instalments, accepted settlements, unpaid per diems and owed reimbursements, which Atlas groups
-- into overdue, this week, later and undated (packages/data groupPaymentsDue). Receivables are left out.
--   * app.payments_due is a definer function behind finance.payment.read, which reads every payment of the org (0321),
--     so the ledger is complete rather than a partial sum under row level security.
--   * A bill that a live instalment of an Approved, Sent or Closed order links appears once, as the instalment, with
--     the bill's outstanding amount and its scheduled payments. A bill linked only to a Proposed or Canceled order's
--     instalment stays a bill row.
--   * An Accepted settlement whose engagement has a live, non-Canceled payable bill in the settlement's currency is left
--     out: the engaged party billed its settlement (app.submit_engagement_invoice, 0765 and 1122) and the bill is what
--     is owed (ADR 0151 item 7, owner step e).
--   * amount_minor is NULL only for an unpriced bill or an unpriced Accepted settlement (Section 3.7): it is never 0.
--     scheduled_minor is what Proposed payments will apply, the Scheduled step of the Gateway tracker (1123).
--   * A reimbursement is due from the org-calendar date its expense was approved (private.zone_date in
--     private.org_time_zone, 1305; owner step d).

create or replace function app.payments_due(p_org_id uuid, p_project_id uuid default null)
returns table (
  kind text,
  source_id uuid,
  project_id uuid,
  project_key text,
  counterparty_id uuid,
  payee_person_id uuid,
  payee_name text,
  label text,
  due_on date,
  currency_code text,
  amount_minor bigint,
  scheduled_minor bigint,
  source_state text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_org_id is null or not private.has_capability(p_org_id, 'finance.payment.read') then
    raise exception using errcode = '42501', message = 'finance.payment.read is required';
  end if;
  return query
  with bills as (
    select v.id, v.project_id, v.counterparty_id, v.payee_person_id, v.invoice_number, v.due_on, v.currency_code,
      v.invoice_state, private.invoice_total(v.id) as total_minor,
      coalesce((select sum(a.amount_minor) from app.payment_applications a join app.payments p on p.id = a.payment_id
                where a.invoice_id = v.id and a.deleted_at is null and p.deleted_at is null and p.payment_state = 'Approved'), 0)::bigint as paid_minor,
      coalesce((select sum(a.amount_minor) from app.payment_applications a join app.payments p on p.id = a.payment_id
                where a.invoice_id = v.id and a.deleted_at is null and p.deleted_at is null and p.payment_state = 'Proposed'), 0)::bigint as planned_minor
    from app.invoices v
    where v.org_id = p_org_id and v.deleted_at is null and v.direction = 'Payable'
  ),
  instalments as (
    select i.id, i.label as instalment_label, i.due_on as instalment_due_on, i.amount_minor as instalment_minor, i.invoice_id,
      po.project_id, po.po_number, po.currency_code, po.po_state, ven.counterparty_id
    from app.po_payment_instalments i
    join app.purchase_orders po on po.id = i.purchase_order_id and po.deleted_at is null
    join app.vendors ven on ven.id = po.vendor_id
    where i.deleted_at is null and po.org_id = p_org_id and po.po_state in ('Approved', 'Sent', 'Closed')
  ),
  due_rows as (
    -- Payable bills not billed through a live instalment.
    select 'invoice'::text as kind, b.id as source_id, b.project_id, b.counterparty_id, b.payee_person_id,
      b.invoice_number as label, b.due_on, b.currency_code::text as currency_code,
      b.total_minor - b.paid_minor as amount_minor, b.planned_minor as scheduled_minor, b.invoice_state::text as source_state
    from bills b
    where b.invoice_state in ('Proposed', 'Approved', 'Disputed')
      and b.id not in (select i.invoice_id from instalments i where i.invoice_id is not null)
      and (b.total_minor is null or b.total_minor - b.paid_minor > 0)
    union all
    -- Instalments: unbilled at their own amount, billed at the bill's outstanding amount.
    select 'instalment', i.id, i.project_id, i.counterparty_id, null::uuid,
      i.instalment_label || ' · PO ' || i.po_number::text,
      case when b.id is null then i.instalment_due_on else coalesce(b.due_on, i.instalment_due_on) end,
      i.currency_code::text,
      case when b.id is null then i.instalment_minor else b.total_minor - b.paid_minor end,
      case when b.id is null then 0::bigint else b.planned_minor end,
      i.po_state::text
    from instalments i
    left join bills b on b.id = i.invoice_id and b.invoice_state <> 'Canceled'
    where b.id is null or b.total_minor is null or b.total_minor - b.paid_minor > 0
    union all
    -- Accepted settlements, unless the engaged party billed them.
    select 'settlement', s.id, s.project_id, e.counterparty_id, case when e.counterparty_id is null then e.person_id end,
      s.title, s.settled_on, s.currency_code::text, private.settlement_total(s.id), 0::bigint, s.settlement_state::text
    from app.settlements s
    join app.engagements e on e.id = s.engagement_id
    where s.org_id = p_org_id and s.deleted_at is null and s.settlement_state = 'Accepted'
      and not exists (
        select 1 from app.invoices v
        where v.engagement_id = s.engagement_id and v.deleted_at is null and v.direction = 'Payable'
          and v.invoice_state <> 'Canceled' and v.currency_code = s.currency_code)
    union all
    -- Unpaid per diems.
    select 'per_diem', d.id, d.project_id, null::uuid, private.per_diem_person(d.id), null::text, d.day,
      d.currency_code::text, d.amount_minor, 0::bigint, null::text
    from app.per_diems d
    where d.org_id = p_org_id and d.deleted_at is null and d.paid_on is null and d.amount_minor > 0
    union all
    -- Owed reimbursements, due from the day they were approved on the org's calendar.
    select 'reimbursement', x.id, bg.project_id, null::uuid, x.submitter_person_id, x.description,
      (select private.zone_date(t.created_at, private.org_time_zone(x.org_id))
       from app.expense_state_transitions t
       where t.expense_id = x.id and t.to_state = 'Approved'
       order by t.created_at desc limit 1),
      x.currency_code::text, x.amount_minor - private.expense_credited_minor(x.id), 0::bigint, x.expense_state::text
    from app.expenses x
    join app.budget_lines bl on bl.id = x.budget_line_id
    join app.budgets bg on bg.id = bl.budget_id
    where x.org_id = p_org_id and x.deleted_at is null and x.is_reimbursable and x.credit_of_expense_id is null
      and x.expense_state = 'Approved' and x.amount_minor - private.expense_credited_minor(x.id) > 0
  )
  select r.kind, r.source_id, r.project_id, pr.project_key::text, r.counterparty_id, r.payee_person_id,
    coalesce(o.name, pe.full_name), r.label, r.due_on, r.currency_code, r.amount_minor, r.scheduled_minor, r.source_state
  from due_rows r
  join app.projects pr on pr.id = r.project_id
  left join app.counterparties c on c.id = r.counterparty_id
  left join app.organizations o on o.id = c.organization_id
  left join app.people pe on pe.id = r.payee_person_id
  where p_project_id is null or r.project_id = p_project_id
  order by r.due_on nulls last, r.kind, r.source_id;
end;
$$;

comment on function app.payments_due(uuid, uuid) is 'What an org owes, one row per outstanding payable (G-184): payable bills in Proposed, Approved or Disputed not billed through a live instalment (kind invoice), instalments of Approved, Sent and Closed purchase orders (instalment; a billed one at its bill''s outstanding amount and due date), Accepted settlements the engaged party has not billed (settlement), unpaid per diems (per_diem) and owed reimbursements due from the org-calendar day of approval (reimbursement). amount_minor is the outstanding amount after Approved payments, NULL only for an unpriced bill or settlement; scheduled_minor is what Proposed payments will apply. Paid and zero rows and receivables are left out. Ordered by due date, undated last. Needs finance.payment.read in the org (42501); p_project_id narrows to one project.';
revoke all on function app.payments_due(uuid, uuid) from public, anon;
grant execute on function app.payments_due(uuid, uuid) to authenticated, service_role;
