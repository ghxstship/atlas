-- 6548_engagement_costs.sql
-- B12 (RRR-236, gap G-186; Section 3.7, ADR 0151 items 4, 5 and 7). The all-in cost of an act: everything an
-- engagement costs the org, per currency, shown beside its settlement (0991, packages/data/src/settlements.ts) and on
-- the engagement.
--   * app.engagement_cost_items lists each cost once, attributed to exactly one engagement in this order: its
--     allocation (app.advance_allocations, its engagement or its roster entry's), then an explicit engagement or roster
--     entry column, then the person it names (private.cost_engagement_for_person, 6547).
--   * Components: settlement (Accepted or Paid: Guarantee, Bonus, Split and Expense less Deduction; Withholding is not
--     subtracted, since the org still pays it, to the tax authority), invoice (the engagement's Approved or Disputed
--     payable bills including tax), travel (segment prices), lodging (nights times the block's nightly rate, per
--     assignment, so a shared room counts per person), per_diem, hospitality (lines of Catering and Amenity fulfillments
--     only, never Canceled ones: Travel and Lodging fulfillments are costed through their segments and rooms, and a
--     segment under a Canceled fulfillment counts for nothing), expense (Approved and Paid
--     charges naming the engagement, net of their credits) and purchase_order (lines naming it on Approved, Sent or
--     Closed orders, without the header tax and shipping, as P4 counts them).
--   * There is no link between a bill and a settlement (app.submit_engagement_invoice, 0765 and 1122), so they offset by
--     amount (ADR 0151 item 7). Every item carries counted_minor, what it adds to the total. A settlement counts in full,
--     withholding not subtracted. An engagement's bills, in order of coalesce(issued_on, due_on) (nulls last), then id,
--     count only the part above what its Accepted and Paid settlements in that currency count. An unpriced bill, an
--     unpriced earlier bill or an unpriced settlement gives NULL, since a window sum that skipped NULL would hide it.
--   * A blank price stays blank: an item without an amount or a currency is unpriced, and app.engagement_costs gives
--     every row of an engagement with an unpriced item a NULL total, with the priced subtotal and the unpriced count
--     beside it. An item with no currency could be in any of them, so its component is NULL on every row of the
--     engagement rather than 0. Currencies are never converted.
--   * Both functions are definer functions that name every capability whose rows they read
--     (app.can_read_engagement_costs): finance.invoice.read (settlements, 0991, and bills), finance.expense.read,
--     procurement.po.read, crew.time_entry.read (per diems, 2692), hospitality.fulfillment.read (travel 0442, fulfillments
--     0351, lodging 0440) and opportunities.engagement.read (the engagement's party) on the project, so a reader sees the
--     whole cost or none. Neither reads a Restricted column: engagements.agreed_rate_minor (0700) is never read.

create or replace function app.can_read_engagement_costs(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.can_on_project(p_project_id, 'finance.invoice.read')
    and private.can_on_project(p_project_id, 'finance.expense.read')
    and private.can_on_project(p_project_id, 'procurement.po.read')
    and private.can_on_project(p_project_id, 'crew.time_entry.read')
    and private.can_on_project(p_project_id, 'hospitality.fulfillment.read')
    and private.can_on_project(p_project_id, 'opportunities.engagement.read'), false);
$$;

comment on function app.can_read_engagement_costs(uuid) is 'Whether the signed-in person reads the all-in cost of the project''s engagements: finance.invoice.read (the settlement read capability, 0991), finance.expense.read, procurement.po.read, crew.time_entry.read, hospitality.fulfillment.read and opportunities.engagement.read on the project, every capability whose rows the roll-up reads.';
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
  parent_id uuid,
  occurred_on date,
  label text,
  currency_code text,
  amount_minor bigint,
  counted_minor bigint
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
    raise exception using errcode = '42501', message = 'finance.invoice.read, finance.expense.read, procurement.po.read, crew.time_entry.read, hospitality.fulfillment.read and opportunities.engagement.read are required on the project';
  end if;
  select pr.time_zone into v_zone from app.projects pr where pr.id = p_project_id;
  return query
  with settlements as (
    select s.id, s.engagement_id, s.settled_on, s.title, s.currency_code,
      (select case when count(l.id) = 0 or count(l.id) filter (where l.amount_minor is null) > 0 then null
                   else sum(case l.line_kind when 'Deduction' then -l.amount_minor when 'Withholding' then 0
                                 else l.amount_minor end)::bigint end
       from app.settlement_lines l where l.settlement_id = s.id and l.deleted_at is null) as amount
    from app.settlements s
    where s.project_id = p_project_id and s.deleted_at is null and s.settlement_state in ('Accepted', 'Paid')
  ),
  settled as (
    select x.engagement_id, x.currency_code, bool_or(x.amount is null) as is_unknown, sum(x.amount)::bigint as settled_minor
    from settlements x group by x.engagement_id, x.currency_code
  ),
  -- The counted bills in order, each with what the earlier ones totalled and whether one of them was unpriced.
  bills as (
    select b.*,
      coalesce(sum(b.total_minor) over earlier, 0)::bigint as prior_minor,
      count(*) filter (where b.total_minor is null) over earlier as prior_unpriced
    from (
      select v.id, v.engagement_id, v.issued_on, v.due_on, v.invoice_number, v.currency_code, private.invoice_total(v.id) as total_minor
      from app.invoices v
      where v.project_id = p_project_id and v.deleted_at is null and v.direction = 'Payable' and v.engagement_id is not null
        and v.invoice_state in ('Approved', 'Disputed')
    ) b
    window earlier as (partition by b.engagement_id, b.currency_code order by coalesce(b.issued_on, b.due_on) nulls last, b.id
      rows between unbounded preceding and 1 preceding)
  ),
  items as (
    select x.engagement_id as engagement, 'settlement'::text as component, 'settlements'::text as source_table, x.id as source_id,
      null::uuid as parent_id, x.settled_on as occurred_on, x.title as label, x.currency_code::text as currency, x.amount, x.amount as counted
    from settlements x
    union all
    select b.engagement_id, 'invoice', 'invoices', b.id, null::uuid, coalesce(b.issued_on, b.due_on), b.invoice_number,
      b.currency_code::text, b.total_minor,
      case when b.total_minor is null or b.prior_unpriced > 0 or coalesce(st.is_unknown, false) then null
           else greatest(b.total_minor - greatest(coalesce(st.settled_minor, 0) - b.prior_minor, 0), 0) end
    from bills b
    left join settled st on st.engagement_id = b.engagement_id and st.currency_code = b.currency_code
    union all
    select coalesce(private.allocation_engagement(t.allocation_id), t.engagement_id,
        private.cost_engagement_for_person(t.project_id, t.person_id)),
      'travel', 'travel_segments', t.id, null::uuid, private.zone_date(t.departs_at, t.departs_time_zone),
      t.departs_from || ' – ' || t.arrives_at_place, t.currency_code::text,
      case when t.currency_code is not null then t.price_minor end,
      case when t.currency_code is not null then t.price_minor end
    from app.travel_segments t
    where t.project_id = p_project_id and t.deleted_at is null
      -- A segment has no state of its own: one under a Canceled fulfillment costs nothing.
      and not exists (select 1 from app.fulfillments cf where cf.id = t.fulfillment_id and cf.fulfillment_state = 'Canceled')
    union all
    select coalesce(private.allocation_engagement(a.allocation_id), private.cost_engagement_for_person(bk.project_id, a.person_id)),
      'lodging', 'accommodation_assignments', a.id, bk.id, a.check_in_on, bk.title, bk.currency_code::text,
      case when bk.currency_code is not null then ((a.check_out_on - a.check_in_on) * bk.nightly_rate_minor)::bigint end,
      case when bk.currency_code is not null then ((a.check_out_on - a.check_in_on) * bk.nightly_rate_minor)::bigint end
    from app.accommodation_assignments a
    join app.accommodation_blocks bk on bk.id = a.accommodation_block_id and bk.deleted_at is null
    where bk.project_id = p_project_id and a.deleted_at is null
    union all
    select coalesce(private.allocation_engagement(d.allocation_id), d.engagement_id,
        (select r.engagement_id from app.engagement_roster_entries r where r.id = d.roster_entry_id),
        private.cost_engagement_for_person(d.project_id, private.per_diem_person(d.id))),
      'per_diem', 'per_diems', d.id, null::uuid, d.day, null::text, d.currency_code::text, d.amount_minor, d.amount_minor
    from app.per_diems d
    where d.project_id = p_project_id and d.deleted_at is null
    union all
    select coalesce(private.allocation_engagement(fl.allocation_id), private.cost_engagement_for_person(f.project_id, fl.person_id)),
      'hospitality', 'fulfillment_lines', fl.id, f.id, private.zone_date(f.starts_at, v_zone), fl.description, fl.currency_code::text,
      case when fl.currency_code is not null then private.extended_minor(fl.quantity, fl.unit_price_minor) end,
      case when fl.currency_code is not null then private.extended_minor(fl.quantity, fl.unit_price_minor) end
    from app.fulfillment_lines fl
    join app.fulfillments f on f.id = fl.fulfillment_id and f.deleted_at is null
    where f.project_id = p_project_id and fl.deleted_at is null and f.fulfillment_kind in ('Catering', 'Amenity')
      -- Canceled and retained (0440): it costs nothing, and its lines can no longer be priced or removed.
      and f.fulfillment_state <> 'Canceled'
    union all
    select x.engagement_id, 'expense', 'expenses', x.id, null::uuid, x.incurred_on, x.description, x.currency_code::text,
      (x.amount_minor - private.expense_credited_minor(x.id))::bigint,
      (x.amount_minor - private.expense_credited_minor(x.id))::bigint
    from app.expenses x
    join app.budget_lines bl on bl.id = x.budget_line_id
    join app.budgets b on b.id = bl.budget_id
    where b.project_id = p_project_id and x.deleted_at is null and x.engagement_id is not null
      and x.credit_of_expense_id is null and x.expense_state in ('Approved', 'Paid')
    union all
    select pl.engagement_id, 'purchase_order', 'po_lines', pl.id, po.id, private.zone_date(po.created_at, v_zone), pl.description,
      po.currency_code::text, private.extended_minor(pl.quantity, pl.unit_price_minor), private.extended_minor(pl.quantity, pl.unit_price_minor)
    from app.po_lines pl
    join app.purchase_orders po on po.id = pl.purchase_order_id and po.deleted_at is null
    where po.project_id = p_project_id and pl.deleted_at is null and pl.engagement_id is not null
      and po.po_state in ('Approved', 'Sent', 'Closed')
  )
  select i.engagement, i.component, i.source_table, i.source_id, i.parent_id, i.occurred_on, i.label, i.currency,
    case when i.currency is not null then i.amount end,
    case when i.currency is not null then i.counted end
  from items i
  join app.engagements e on e.id = i.engagement and e.project_id = p_project_id and e.deleted_at is null
  where p_engagement_id is null or i.engagement = p_engagement_id
  order by i.engagement, i.component, i.occurred_on nulls last, i.source_id;
end;
$$;

comment on function app.engagement_cost_items(uuid, uuid) is 'Every cost of the project''s engagements, or of one (G-186), each attributed to exactly one engagement: by its allocation, then an explicit engagement or roster entry, then the person it names (private.cost_engagement_for_person). Components settlement (Accepted or Paid; Guarantee, Bonus, Split and Expense less Deduction, Withholding not subtracted), invoice (Approved or Disputed payable bills of the engagement including tax), travel, lodging (nights times nightly rate), per_diem, hospitality (Catering and Amenity lines), expense (Approved and Paid charges net of credits) and purchase_order (lines of Approved, Sent and Closed orders without header tax and shipping). amount_minor and currency_code are NULL when unpriced. counted_minor is what the item adds to the total: a settlement in full; an engagement bill only the part above its engagement''s Accepted and Paid settlements in that currency, in order of date then id, NULL when it, an earlier bill or a settlement is unpriced; any other item its amount. parent_id names the record the item opens under: a line''s order, a fulfillment line''s fulfillment, a room''s block. Needs finance.invoice.read, finance.expense.read, procurement.po.read, crew.time_entry.read, hospitality.fulfillment.read and opportunities.engagement.read on the project (42501). Reads no Restricted column.';
revoke all on function app.engagement_cost_items(uuid, uuid) from public, anon;
grant execute on function app.engagement_cost_items(uuid, uuid) to authenticated, service_role;

create or replace function app.engagement_costs(p_project_id uuid, p_engagement_id uuid default null)
returns table (
  engagement_id uuid,
  counterparty_id uuid,
  person_id uuid,
  role_type app.external_role_type,
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
    select * from app.engagement_cost_items(p_project_id, p_engagement_id) i
  ),
  unpriced as (
    select i.engagement_id as engagement, (count(*) filter (where i.counted_minor is null))::integer as n
    from items i group by i.engagement_id
  ),
  currencies as (
    select distinct i.engagement_id as engagement, i.currency_code as currency from items i where i.currency_code is not null
    union all
    select u.engagement, null::text from unpriced u
    where not exists (select 1 from items i where i.engagement_id = u.engagement and i.currency_code is not null)
  )
  select c.engagement, e.counterparty_id, e.person_id, e.role_type, c.currency,
    s.settlement, s.invoice, s.travel, s.lodging, s.per_diem, s.hospitality, s.expense, s.purchase_order,
    coalesce(s.priced, 0)::bigint,
    case when u.n > 0 then null else coalesce(s.priced, 0)::bigint end,
    u.n
  from currencies c
  join unpriced u on u.engagement = c.engagement
  join app.engagements e on e.id = c.engagement
  cross join lateral (
    select
      case when count(*) filter (where i.component = 'settlement' and i.counted_minor is null) > 0 then null
           else coalesce(sum(i.counted_minor) filter (where i.component = 'settlement'), 0) end::bigint as settlement,
      case when count(*) filter (where i.component = 'invoice' and i.counted_minor is null) > 0 then null
           else coalesce(sum(i.counted_minor) filter (where i.component = 'invoice'), 0) end::bigint as invoice,
      case when count(*) filter (where i.component = 'travel' and i.counted_minor is null) > 0 then null
           else coalesce(sum(i.counted_minor) filter (where i.component = 'travel'), 0) end::bigint as travel,
      case when count(*) filter (where i.component = 'lodging' and i.counted_minor is null) > 0 then null
           else coalesce(sum(i.counted_minor) filter (where i.component = 'lodging'), 0) end::bigint as lodging,
      case when count(*) filter (where i.component = 'per_diem' and i.counted_minor is null) > 0 then null
           else coalesce(sum(i.counted_minor) filter (where i.component = 'per_diem'), 0) end::bigint as per_diem,
      case when count(*) filter (where i.component = 'hospitality' and i.counted_minor is null) > 0 then null
           else coalesce(sum(i.counted_minor) filter (where i.component = 'hospitality'), 0) end::bigint as hospitality,
      case when count(*) filter (where i.component = 'expense' and i.counted_minor is null) > 0 then null
           else coalesce(sum(i.counted_minor) filter (where i.component = 'expense'), 0) end::bigint as expense,
      case when count(*) filter (where i.component = 'purchase_order' and i.counted_minor is null) > 0 then null
           else coalesce(sum(i.counted_minor) filter (where i.component = 'purchase_order'), 0) end::bigint as purchase_order,
      sum(i.counted_minor)::bigint as priced
    from items i
    where i.engagement_id = c.engagement and (i.currency_code = c.currency or i.currency_code is null)
  ) s
  order by c.engagement, c.currency nulls last;
$$;

comment on function app.engagement_costs(uuid, uuid) is 'The all-in cost of the project''s engagements, or of one (G-186), one row per engagement and currency from app.engagement_cost_items, with the engagement''s counterparty, person and role type: each component''s sum of counted_minor (NULL when one of its items in the currency, or one with no currency, is unpriced), the priced total, and total_minor, NULL on every row of an engagement while any of its counted items is unpriced (Section 3.7), with unpriced_count, the engagement''s unpriced items, on each row. An engagement whose items are all unpriced has one row with no currency. Currencies are never converted; a bill counts only the part above its engagement''s settlements. Needs the six capabilities of app.can_read_engagement_costs on the project (42501).';
revoke all on function app.engagement_costs(uuid, uuid) from public, anon;
grant execute on function app.engagement_costs(uuid, uuid) to authenticated, service_role;
