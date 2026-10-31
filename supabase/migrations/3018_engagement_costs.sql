-- 3018_engagement_costs.sql
-- B12 (RRR-236, gap G-186; Section 3.7, ADR 0151 items 4, 5 and 7). The all-in cost of an act: everything an
-- engagement costs the org, per currency, shown beside its settlement (0991, packages/data/src/settlements.ts) and on
-- the engagement.
--   * app.engagement_cost_items lists each cost once, attributed to exactly one engagement in this order: its
--     allocation (app.advance_allocations, its engagement or its roster entry's), then an explicit engagement or roster
--     entry column, then the person it names (private.cost_engagement_for_person, 3017).
--   * Components: settlement (Accepted or Paid: Guarantee, Bonus, Split and Expense less Deduction; Withholding is not
--     subtracted, since the org still pays it, to the tax authority), invoice (the engagement's Approved or Disputed
--     payable bills including tax), travel (segment prices), lodging (nights times the block's nightly rate, per
--     assignment, so a shared room counts per person), per_diem, hospitality (lines of Catering and Amenity fulfillments
--     only: Travel and Lodging fulfillments are costed through their segments and rooms), expense (Approved and Paid
--     charges naming the engagement, net of their credits) and purchase_order (lines naming it on Approved, Sent or
--     Closed orders, without the header tax and shipping, as P4 counts them).
--   * A bill the engaged party sends in a currency where its engagement has an Accepted or Paid settlement is the
--     settlement billed (app.submit_engagement_invoice, 0765 and 1122): it is listed with counts_in_total false and
--     left out of the sums (ADR 0151 item 7, owner step e).
--   * A blank price stays blank: an item without an amount or a currency is unpriced, and app.engagement_costs gives
--     every row of an engagement with an unpriced item a NULL total, with the priced subtotal and the unpriced count
--     beside it. Currencies are never converted.
--   * Both functions are definer functions behind finance.invoice.read and finance.expense.read on the project, so a
--     reader sees the whole cost or none. Neither reads a Restricted column: engagements.agreed_rate_minor (0700) is
--     never read.

create or replace function app.can_read_engagement_costs(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.can_on_project(p_project_id, 'finance.invoice.read')
    and private.can_on_project(p_project_id, 'finance.expense.read'), false);
$$;

comment on function app.can_read_engagement_costs(uuid) is 'Whether the signed-in person reads the all-in cost of the project''s engagements: finance.invoice.read (the settlement read capability, 0991) and finance.expense.read on the project.';
revoke all on function app.can_read_engagement_costs(uuid) from public, anon;
grant execute on function app.can_read_engagement_costs(uuid) to authenticated, service_role;

-- The engagement an allocation's items belong to: its own, or its roster entry's.
create or replace function private.allocation_engagement(p_allocation_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(a.engagement_id, r.engagement_id)
  from app.advance_allocations a
  left join app.engagement_roster_entries r on r.id = a.roster_entry_id
  where a.id = p_allocation_id;
$$;

comment on function private.allocation_engagement(uuid) is 'The engagement an allocation is held under: its own engagement for a party pool, else its roster entry''s. NULL for a NULL allocation.';
revoke all on function private.allocation_engagement(uuid) from public, anon, authenticated;

create or replace function app.engagement_cost_items(p_project_id uuid, p_engagement_id uuid default null)
returns table (
  engagement_id uuid,
  component text,
  source_table text,
  source_id uuid,
  occurred_on date,
  label text,
  currency_code text,
  amount_minor bigint,
  counts_in_total boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_zone text;
begin
  if p_project_id is null or not app.can_read_engagement_costs(p_project_id) then
    raise exception using errcode = '42501', message = 'finance.invoice.read and finance.expense.read are required on the project';
  end if;
  select pr.time_zone into v_zone from app.projects pr where pr.id = p_project_id;
  return query
  with settled as (
    select s.engagement_id, s.currency_code
    from app.settlements s
    where s.project_id = p_project_id and s.deleted_at is null and s.settlement_state in ('Accepted', 'Paid')
  ),
  items as (
    select s.engagement_id as engagement, 'settlement'::text as component, 'settlements'::text as source_table, s.id as source_id,
      s.settled_on as occurred_on, s.title as label, s.currency_code::text as currency,
      (select case when count(l.id) = 0 or count(l.id) filter (where l.amount_minor is null) > 0 then null
                   else sum(case l.line_kind when 'Deduction' then -l.amount_minor when 'Withholding' then 0
                                 else l.amount_minor end)::bigint end
       from app.settlement_lines l where l.settlement_id = s.id and l.deleted_at is null) as amount,
      true as counted
    from app.settlements s
    where s.project_id = p_project_id and s.deleted_at is null and s.settlement_state in ('Accepted', 'Paid')
    union all
    select v.engagement_id, 'invoice', 'invoices', v.id, coalesce(v.issued_on, v.due_on), v.invoice_number,
      v.currency_code::text, private.invoice_total(v.id),
      not exists (select 1 from settled x where x.engagement_id = v.engagement_id and x.currency_code = v.currency_code)
    from app.invoices v
    where v.project_id = p_project_id and v.deleted_at is null and v.direction = 'Payable' and v.engagement_id is not null
      and v.invoice_state in ('Approved', 'Disputed')
    union all
    select coalesce(private.allocation_engagement(t.allocation_id), t.engagement_id,
        private.cost_engagement_for_person(t.project_id, t.person_id)),
      'travel', 'travel_segments', t.id, private.zone_date(t.departs_at, t.departs_time_zone),
      t.departs_from || ' – ' || t.arrives_at_place, t.currency_code::text,
      case when t.currency_code is not null then t.price_minor end, true
    from app.travel_segments t
    where t.project_id = p_project_id and t.deleted_at is null
    union all
    select coalesce(private.allocation_engagement(a.allocation_id), private.cost_engagement_for_person(bk.project_id, a.person_id)),
      'lodging', 'accommodation_assignments', a.id, a.check_in_on, bk.title, bk.currency_code::text,
      case when bk.currency_code is not null then ((a.check_out_on - a.check_in_on) * bk.nightly_rate_minor)::bigint end, true
    from app.accommodation_assignments a
    join app.accommodation_blocks bk on bk.id = a.accommodation_block_id and bk.deleted_at is null
    where bk.project_id = p_project_id and a.deleted_at is null
    union all
    select coalesce(private.allocation_engagement(d.allocation_id), d.engagement_id,
        (select r.engagement_id from app.engagement_roster_entries r where r.id = d.roster_entry_id)),
      'per_diem', 'per_diems', d.id, d.day, null::text, d.currency_code::text, d.amount_minor, true
    from app.per_diems d
    where d.project_id = p_project_id and d.deleted_at is null
    union all
    select coalesce(private.allocation_engagement(fl.allocation_id), private.cost_engagement_for_person(f.project_id, fl.person_id)),
      'hospitality', 'fulfillment_lines', fl.id, private.zone_date(f.starts_at, v_zone), fl.description, fl.currency_code::text,
      case when fl.currency_code is not null then private.extended_minor(fl.quantity, fl.unit_price_minor) end, true
    from app.fulfillment_lines fl
    join app.fulfillments f on f.id = fl.fulfillment_id and f.deleted_at is null
    where f.project_id = p_project_id and fl.deleted_at is null and f.fulfillment_kind in ('Catering', 'Amenity')
    union all
    select x.engagement_id, 'expense', 'expenses', x.id, x.incurred_on, x.description, x.currency_code::text,
      (x.amount_minor - private.expense_credited_minor(x.id))::bigint, true
    from app.expenses x
    join app.budget_lines bl on bl.id = x.budget_line_id
    join app.budgets b on b.id = bl.budget_id
    where b.project_id = p_project_id and x.deleted_at is null and x.engagement_id is not null
      and x.credit_of_expense_id is null and x.expense_state in ('Approved', 'Paid')
    union all
    select pl.engagement_id, 'purchase_order', 'po_lines', pl.id, private.zone_date(po.created_at, v_zone), pl.description,
      po.currency_code::text, private.extended_minor(pl.quantity, pl.unit_price_minor), true
    from app.po_lines pl
    join app.purchase_orders po on po.id = pl.purchase_order_id and po.deleted_at is null
    where po.project_id = p_project_id and pl.deleted_at is null and pl.engagement_id is not null
      and po.po_state in ('Approved', 'Sent', 'Closed')
  )
  select i.engagement, i.component, i.source_table, i.source_id, i.occurred_on, i.label, i.currency,
    case when i.currency is not null then i.amount end, i.counted
  from items i
  join app.engagements e on e.id = i.engagement and e.project_id = p_project_id and e.deleted_at is null
  where p_engagement_id is null or i.engagement = p_engagement_id
  order by i.engagement, i.component, i.occurred_on nulls last, i.source_id;
end;
$$;

comment on function app.engagement_cost_items(uuid, uuid) is 'Every cost of the project''s engagements, or of one (G-186), each attributed to exactly one engagement: by its allocation, then an explicit engagement or roster entry, then the person it names (private.cost_engagement_for_person). Components settlement (Accepted or Paid; Guarantee, Bonus, Split and Expense less Deduction, Withholding not subtracted), invoice (Approved or Disputed payable bills of the engagement including tax), travel, lodging (nights times nightly rate), per_diem, hospitality (Catering and Amenity lines), expense (Approved and Paid charges net of credits) and purchase_order (lines of Approved, Sent and Closed orders without header tax and shipping). amount_minor and currency_code are NULL when unpriced. counts_in_total is false for an engagement bill in a currency with an Accepted or Paid settlement, which bills that settlement. Needs finance.invoice.read and finance.expense.read on the project (42501). Reads no Restricted column.';
revoke all on function app.engagement_cost_items(uuid, uuid) from public, anon;
grant execute on function app.engagement_cost_items(uuid, uuid) to authenticated, service_role;

create or replace function app.engagement_costs(p_project_id uuid, p_engagement_id uuid default null)
returns table (
  engagement_id uuid,
  currency_code text,
  settlement_minor bigint,
  invoice_minor bigint,
  travel_minor bigint,
  lodging_minor bigint,
  per_diem_minor bigint,
  hospitality_minor bigint,
  expense_minor bigint,
  purchase_order_minor bigint,
  priced_total_minor bigint,
  total_minor bigint,
  unpriced_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with items as (
    select * from app.engagement_cost_items(p_project_id, p_engagement_id) i where i.counts_in_total
  ),
  unpriced as (
    select i.engagement_id as engagement, (count(*) filter (where i.amount_minor is null))::integer as n
    from items i group by i.engagement_id
  ),
  currencies as (
    select distinct i.engagement_id as engagement, i.currency_code as currency from items i where i.currency_code is not null
    union all
    select u.engagement, null::text from unpriced u
    where not exists (select 1 from items i where i.engagement_id = u.engagement and i.currency_code is not null)
  )
  select c.engagement, c.currency,
    s.settlement, s.invoice, s.travel, s.lodging, s.per_diem, s.hospitality, s.expense, s.purchase_order,
    coalesce(s.priced, 0)::bigint,
    case when u.n > 0 then null else coalesce(s.priced, 0)::bigint end,
    u.n
  from currencies c
  join unpriced u on u.engagement = c.engagement
  cross join lateral (
    select
      case when count(*) filter (where i.component = 'settlement' and i.amount_minor is null) > 0 then null
           else coalesce(sum(i.amount_minor) filter (where i.component = 'settlement'), 0) end::bigint as settlement,
      case when count(*) filter (where i.component = 'invoice' and i.amount_minor is null) > 0 then null
           else coalesce(sum(i.amount_minor) filter (where i.component = 'invoice'), 0) end::bigint as invoice,
      case when count(*) filter (where i.component = 'travel' and i.amount_minor is null) > 0 then null
           else coalesce(sum(i.amount_minor) filter (where i.component = 'travel'), 0) end::bigint as travel,
      case when count(*) filter (where i.component = 'lodging' and i.amount_minor is null) > 0 then null
           else coalesce(sum(i.amount_minor) filter (where i.component = 'lodging'), 0) end::bigint as lodging,
      case when count(*) filter (where i.component = 'per_diem' and i.amount_minor is null) > 0 then null
           else coalesce(sum(i.amount_minor) filter (where i.component = 'per_diem'), 0) end::bigint as per_diem,
      case when count(*) filter (where i.component = 'hospitality' and i.amount_minor is null) > 0 then null
           else coalesce(sum(i.amount_minor) filter (where i.component = 'hospitality'), 0) end::bigint as hospitality,
      case when count(*) filter (where i.component = 'expense' and i.amount_minor is null) > 0 then null
           else coalesce(sum(i.amount_minor) filter (where i.component = 'expense'), 0) end::bigint as expense,
      case when count(*) filter (where i.component = 'purchase_order' and i.amount_minor is null) > 0 then null
           else coalesce(sum(i.amount_minor) filter (where i.component = 'purchase_order'), 0) end::bigint as purchase_order,
      sum(i.amount_minor)::bigint as priced
    from items i
    where i.engagement_id = c.engagement and i.currency_code is not distinct from c.currency
  ) s
  order by c.engagement, c.currency nulls last;
$$;

comment on function app.engagement_costs(uuid, uuid) is 'The all-in cost of the project''s engagements, or of one (G-186), one row per engagement and currency from app.engagement_cost_items: each component''s sum (NULL when one of its items in the currency is unpriced), the priced total, and total_minor, NULL on every row of an engagement while any of its counted items is unpriced (Section 3.7), with unpriced_count, the engagement''s unpriced items, on each row. An engagement whose items are all unpriced has one row with no currency. Currencies are never converted; bills that bill a settlement are left out. Needs finance.invoice.read and finance.expense.read on the project (42501).';
revoke all on function app.engagement_costs(uuid, uuid) from public, anon;
grant execute on function app.engagement_costs(uuid, uuid) to authenticated, service_role;
