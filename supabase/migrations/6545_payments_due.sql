-- 6545_payments_due.sql
-- B12 (RRR-236, gap G-184; Section 3.7, ADR 0151 items 4 and 7). One ledger of what an org owes and when: payable
-- bills, purchase order instalments, accepted settlements, unpaid per diems, owed reimbursements and approved charges,
-- which Atlas groups into overdue, this week, later and undated (packages/data groupPaymentsDue). Receivables are left
-- out.
--   * app.payments_due is a definer function that names every capability whose rows it reads
--     (private.can_read_payments_due: finance.payment.read, finance.invoice.read, finance.expense.read,
--     procurement.po.read and crew.time_entry.read at organization reach), so a reader sees the complete ledger or none,
--     never a partial sum under row level security, and a definer function is not a way around a role check.
--   * It returns person ids and the counterparty's organization name, and reads no name from app.people:
--     packages/data fills person names through app.person_names.
--   * A bill that a live instalment of an Approved, Sent or Closed order links appears once, as the instalment, with
--     the bill's outstanding amount and its scheduled payments. A bill linked only to a Proposed or Canceled order's
--     instalment stays a bill row, and a Canceled order's instalments are never listed. An instalment whose bill is
--     Canceled or soft-deleted is unbilled (private.po_instalment_billed, 6543).
--   * A bill matched to an order (app.invoice_matches) but linked to no live instalment would list beside the order's
--     unbilled instalment for the same money. So an order's unbilled instalments, in instalment_number order, consume
--     the summed totals of those bills: billed_offset_minor says what was taken off, a row at zero is left out, and an
--     unpriced bill gives NULL.
--   * There is no link between a bill and a settlement (app.submit_engagement_invoice, 0765 and 1122), so per engagement
--     and currency, Accepted and Paid settlements consume what the engagement's live, non-Canceled payable bills total, in
--     order of settled_on (nulls last), then id, each at its net (private.settlement_total). An Accepted settlement lists
--     the part above that, with billed_offset_minor beside it, and is left out at zero. Unknown billed, an unpriced
--     settlement, or an unpriced earlier settlement gives NULL (ADR 0151 item 7).
--   * amount_minor is NULL only when unpriced (Section 3.7): it is never 0. scheduled_minor is what Proposed payments will
--     apply, the Scheduled step of the Gateway tracker (1123).
--   * Approval credits Accounts Payable (1611), so an Approved, non-reimbursable charge that is not a credit is owed at its
--     net of approved credits (kind expense), and an Approved reimbursable charge is owed to its submitter (kind
--     reimbursement). Each is due from the local date of its approval in the project's time zone, the latest move from
--     Proposed to Approved, so a voided reimbursement keeps its original due date. Approved credits are refunds coming in,
--     so they stay out.
--   * Each row carries project_today, the project's local date, so a bucket is decided by that project's day.

create or replace function private.can_read_payments_due(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.has_capability(p_org_id, 'finance.payment.read')
    and private.has_capability(p_org_id, 'finance.invoice.read')
    and private.has_capability(p_org_id, 'finance.expense.read')
    and private.has_capability(p_org_id, 'procurement.po.read')
    and private.has_capability(p_org_id, 'crew.time_entry.read'), false);
$$;

comment on function private.can_read_payments_due(uuid) is 'True when the signed-in person holds, at organization reach, every capability whose rows app.payments_due reads: finance.payment.read, finance.invoice.read, finance.expense.read, procurement.po.read and crew.time_entry.read.';
revoke all on function private.can_read_payments_due(uuid) from public, anon, authenticated;

create or replace function app.can_read_payments_due(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_read_payments_due(p_org_id);
$$;

comment on function app.can_read_payments_due(uuid) is 'Whether the signed-in person reads the payments-due ledger of the org: Atlas shows the Due tab or a refusal by it. For showing controls only; app.payments_due checks again.';
revoke all on function app.can_read_payments_due(uuid) from public, anon;
grant execute on function app.can_read_payments_due(uuid) to authenticated, service_role;

create or replace function app.payments_due(p_org_id uuid, p_project_id uuid default null)
returns table (
  kind text,
  source_id uuid,
  purchase_order_id uuid,
  project_id uuid,
  project_key text,
  project_today date,
  counterparty_id uuid,
  counterparty_name text,
  payee_person_id uuid,
  label text,
  due_on date,
  currency_code text,
  amount_minor bigint,
  scheduled_minor bigint,
  billed_offset_minor bigint,
  source_state text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_org_id is null or not private.can_read_payments_due(p_org_id) then
    raise exception using errcode = '42501', message = 'finance.payment.read, finance.invoice.read, finance.expense.read, procurement.po.read and crew.time_entry.read are required in the org';
  end if;
  return query
  with bills as (
    select v.id, v.project_id, v.counterparty_id, v.payee_person_id, v.engagement_id, v.invoice_number, v.due_on, v.currency_code,
      v.invoice_state, private.invoice_total(v.id) as total_minor,
      coalesce((select sum(a.amount_minor) from app.payment_applications a join app.payments p on p.id = a.payment_id
                where a.invoice_id = v.id and a.deleted_at is null and p.deleted_at is null and p.payment_state = 'Approved'), 0)::bigint as paid_minor,
      coalesce((select sum(a.amount_minor) from app.payment_applications a join app.payments p on p.id = a.payment_id
                where a.invoice_id = v.id and a.deleted_at is null and p.deleted_at is null and p.payment_state = 'Proposed'), 0)::bigint as planned_minor
    from app.invoices v
    where v.org_id = p_org_id and v.deleted_at is null and v.direction = 'Payable'
  ),
  instalments as (
    select i.id, i.instalment_number, i.purchase_order_id, i.label as instalment_label, i.due_on as instalment_due_on,
      i.amount_minor as instalment_minor, b.id as bill_id,
      po.project_id, po.po_number, po.currency_code, po.po_state, ven.counterparty_id
    from app.po_payment_instalments i
    join app.purchase_orders po on po.id = i.purchase_order_id and po.deleted_at is null
    join app.vendors ven on ven.id = po.vendor_id
    left join bills b on b.id = i.invoice_id and b.invoice_state <> 'Canceled'
    where i.deleted_at is null and po.org_id = p_org_id and po.po_state in ('Approved', 'Sent', 'Closed')
  ),
  -- What an order's bills total when they are matched to it and linked to no live instalment.
  matched as (
    select m.purchase_order_id, bool_or(b.total_minor is null) as is_unknown, sum(b.total_minor)::bigint as matched_minor
    from app.invoice_matches m
    join bills b on b.id = m.invoice_id and b.invoice_state <> 'Canceled'
    where m.deleted_at is null
      and not exists (select 1 from app.po_payment_instalments x where x.invoice_id = b.id and x.deleted_at is null)
    group by m.purchase_order_id
  ),
  unbilled as (
    select i.id,
      case when coalesce(mt.is_unknown, false) then null
           else i.instalment_minor - greatest(i.instalment_minor - greatest(coalesce(mt.matched_minor, 0) - i.prior_minor, 0), 0) end as offset_minor
    from (
      select x.id, x.purchase_order_id, x.instalment_minor,
        coalesce(sum(x.instalment_minor) over (partition by x.purchase_order_id order by x.instalment_number
          rows between unbounded preceding and 1 preceding), 0)::bigint as prior_minor
      from instalments x where x.bill_id is null
    ) i
    left join matched mt on mt.purchase_order_id = i.purchase_order_id
  ),
  -- What an engagement's bills total per currency, and the settlements that consume it.
  billed as (
    select b.engagement_id, b.currency_code, bool_or(b.total_minor is null) as is_unknown, sum(b.total_minor)::bigint as billed_minor
    from bills b
    where b.engagement_id is not null and b.invoice_state <> 'Canceled'
    group by b.engagement_id, b.currency_code
  ),
  settled as (
    select w.id, w.engagement_id, w.net_minor, w.settlement_state,
      case when w.net_minor is null or w.prior_unpriced > 0 or coalesce(bd.is_unknown, false) then null
           else least(greatest(w.net_minor, 0), greatest(coalesce(bd.billed_minor, 0) - w.prior_net, 0)) end as offset_minor
    from (
      select s.id, s.engagement_id, s.currency_code, s.settlement_state, private.settlement_total(s.id) as net_minor,
        coalesce(sum(greatest(private.settlement_total(s.id), 0)) over earlier, 0)::bigint as prior_net,
        count(*) filter (where private.settlement_total(s.id) is null) over earlier as prior_unpriced
      from app.settlements s
      where s.org_id = p_org_id and s.deleted_at is null and s.settlement_state in ('Accepted', 'Paid')
      window earlier as (partition by s.engagement_id, s.currency_code order by s.settled_on nulls last, s.id
        rows between unbounded preceding and 1 preceding)
    ) w
    left join billed bd on bd.engagement_id = w.engagement_id and bd.currency_code = w.currency_code
  ),
  due_rows as (
    -- Payable bills not billed through a live instalment.
    select 'invoice'::text as kind, b.id as source_id, null::uuid as purchase_order_id, b.project_id, b.counterparty_id, b.payee_person_id,
      b.invoice_number as label, b.due_on, b.currency_code::text as currency_code,
      b.total_minor - b.paid_minor as amount_minor, b.planned_minor as scheduled_minor, 0::bigint as billed_offset_minor,
      b.invoice_state::text as source_state
    from bills b
    where b.invoice_state in ('Proposed', 'Approved', 'Disputed')
      and b.id not in (select i.bill_id from instalments i where i.bill_id is not null)
      and (b.total_minor is null or b.total_minor - b.paid_minor > 0)
    union all
    -- Billed instalments, at the bill's outstanding amount and due date.
    select 'instalment', i.id, i.purchase_order_id, i.project_id, i.counterparty_id, null::uuid,
      i.instalment_label || ' · PO ' || i.po_number::text, coalesce(b.due_on, i.instalment_due_on), i.currency_code::text,
      b.total_minor - b.paid_minor, b.planned_minor, 0::bigint, i.po_state::text
    from instalments i
    join bills b on b.id = i.bill_id
    where b.total_minor is null or b.total_minor - b.paid_minor > 0
    union all
    -- Unbilled instalments, at their own amount less what matched bills have already claimed.
    select 'instalment', i.id, i.purchase_order_id, i.project_id, i.counterparty_id, null::uuid,
      i.instalment_label || ' · PO ' || i.po_number::text, i.instalment_due_on, i.currency_code::text,
      i.instalment_minor - u.offset_minor, 0::bigint, u.offset_minor, i.po_state::text
    from instalments i
    join unbilled u on u.id = i.id
    where u.offset_minor is null or i.instalment_minor - u.offset_minor > 0
    union all
    -- Accepted settlements, at the part the engagement's bills have not claimed.
    select 'settlement', s.id, null::uuid, s.project_id, e.counterparty_id, case when e.counterparty_id is null then e.person_id end,
      s.title, s.settled_on, s.currency_code::text, w.net_minor - w.offset_minor, 0::bigint, w.offset_minor, s.settlement_state::text
    from settled w
    join app.settlements s on s.id = w.id
    join app.engagements e on e.id = w.engagement_id
    where w.settlement_state = 'Accepted' and (w.offset_minor is null or w.net_minor - w.offset_minor > 0)
    union all
    -- Unpaid per diems.
    select 'per_diem', d.id, null::uuid, d.project_id, null::uuid, private.per_diem_person(d.id), null::text, d.day,
      d.currency_code::text, d.amount_minor, 0::bigint, 0::bigint, null::text
    from app.per_diems d
    where d.org_id = p_org_id and d.deleted_at is null and d.paid_on is null and d.amount_minor > 0
    union all
    -- Approved charges at their net: owed to the submitter when reimbursable, otherwise to the vendor. Due from the local
    -- date of approval in the project's time zone.
    select case when x.is_reimbursable then 'reimbursement' else 'expense' end, x.id, null::uuid, bg.project_id,
      case when x.is_reimbursable then null else x.counterparty_id end,
      case when x.is_reimbursable then x.submitter_person_id end,
      x.description,
      (select private.zone_date(t.created_at, pr.time_zone)
       from app.expense_state_transitions t
       where t.expense_id = x.id and t.from_state = 'Proposed' and t.to_state = 'Approved'
       order by t.created_at desc limit 1),
      x.currency_code::text, x.amount_minor - private.expense_credited_minor(x.id), 0::bigint, 0::bigint, x.expense_state::text
    from app.expenses x
    join app.budget_lines bl on bl.id = x.budget_line_id
    join app.budgets bg on bg.id = bl.budget_id
    join app.projects pr on pr.id = bg.project_id
    where x.org_id = p_org_id and x.deleted_at is null and x.credit_of_expense_id is null
      and x.expense_state = 'Approved' and x.amount_minor - private.expense_credited_minor(x.id) > 0
  )
  select r.kind, r.source_id, r.purchase_order_id, r.project_id, pr.project_key::text, private.project_today(r.project_id),
    r.counterparty_id, o.name::text, r.payee_person_id, r.label, r.due_on, r.currency_code, r.amount_minor, r.scheduled_minor,
    r.billed_offset_minor, r.source_state
  from due_rows r
  join app.projects pr on pr.id = r.project_id
  left join app.counterparties c on c.id = r.counterparty_id
  left join app.organizations o on o.id = c.organization_id
  where p_project_id is null or r.project_id = p_project_id
  order by r.due_on nulls last, r.kind, r.source_id;
end;
$$;

comment on function app.payments_due(uuid, uuid) is 'What an org owes, one row per outstanding payable (G-184): payable bills in Proposed, Approved or Disputed not billed through a live instalment (kind invoice); instalments of Approved, Sent and Closed purchase orders (instalment; a billed one at its bill''s outstanding amount and due date, an unbilled one less what bills matched to the order and linked to no instalment have claimed); Accepted settlements at the part the engagement''s live, non-Canceled payable bills have not claimed, per currency, in order of settled_on (settlement); unpaid per diems (per_diem); owed reimbursements (reimbursement) and Approved non-reimbursable charges (expense), each net of approved credits and due from the local date of approval in the project''s time zone. amount_minor is the outstanding amount, NULL only when unpriced, including when an unpriced earlier row or an unpriced bill makes the offset unknown. scheduled_minor is what Proposed payments will apply; billed_offset_minor what bills took off the row. project_today is the project''s local date. Paid and zero rows and receivables are left out. Ordered by due date, undated last. Needs finance.payment.read, finance.invoice.read, finance.expense.read, procurement.po.read and crew.time_entry.read at organization reach (42501); p_project_id narrows to one project. Returns person ids, never names: read them through app.person_names.';
revoke all on function app.payments_due(uuid, uuid) from public, anon;
grant execute on function app.payments_due(uuid, uuid) to authenticated, service_role;
