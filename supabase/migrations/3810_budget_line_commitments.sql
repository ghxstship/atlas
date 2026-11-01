-- 2810_budget_line_commitments.sql
-- P4 (RRR-218, gap G-204; Section 4.2 Finance, Section 7.4 Analytics). Planned, committed and actual on every live
-- budget line. Committed is what approved purchase orders have ordered against the line, derived and never stored
-- (Section 3.15, ADR 0103), so a budget reads Extended, Committed and Actual side by side.
--
--   * app.budget_line_commitments sums the live lines of live purchase orders in Approved, Sent or Closed that draw on
--     a budget line in the budget's own currency. A line on an order in another currency is counted and never summed:
--     XOS converts no money silently. Approved PO change orders (app.po_change_orders) amend a whole order and carry no
--     budget line, so they are not allocated to lines; approved budget change orders (app.change_orders) amend the
--     budget itself and already count in Approved changes and Revised (0480), never in Committed.
--   * The view is security invoker, and purchase orders and their lines are read with procurement.po.read (0331). A
--     reader without it on the project would see a partial sum, so the view withholds the figure instead: the silence
--     rule, never a partial number.
--   * app.budget_line_facts (0480) gains the committed columns after actual_minor, so the budget versus actual report
--     and the collection exports read them with the rest of a line.

-- Commitments per budget line ------------------------------------------------------------------------------------------

create view app.budget_line_commitments with (security_invoker = true) as
select bl.id as budget_line_id, b.id as budget_id, b.project_id, b.currency_code,
  case when w.is_withheld or coalesce(po.unpriced_count, 0) > 0 then null
       else coalesce(po.committed_minor, 0) end::bigint as committed_minor,
  coalesce(po.line_count, 0)::integer as po_line_count,
  coalesce(po.other_currency_count, 0)::integer as other_currency_po_line_count,
  w.is_withheld as is_committed_withheld
from app.budget_lines bl
join app.budgets b on b.id = bl.budget_id
cross join lateral (
  select b.project_id not in (select private.project_ids_with('procurement.po.read')) as is_withheld
) w
left join lateral (
  select
    count(*) filter (where o.currency_code = b.currency_code) as line_count,
    count(*) filter (where o.currency_code <> b.currency_code) as other_currency_count,
    count(*) filter (where o.currency_code = b.currency_code and pl.unit_price_minor is null) as unpriced_count,
    sum(private.extended_minor(pl.quantity, pl.unit_price_minor)) filter (where o.currency_code = b.currency_code)
      as committed_minor
  from app.po_lines pl
  join app.purchase_orders o on o.id = pl.purchase_order_id
  where pl.budget_line_id = bl.id
    and pl.deleted_at is null
    and o.deleted_at is null
    and o.po_state in ('Approved', 'Sent', 'Closed')
) po on true
where bl.deleted_at is null and b.deleted_at is null;

call private.describe('app.budget_line_commitments', 'One row per live budget line of a live budget with what approved purchase orders commit against it (Section 4.2, gap G-204). Committed sums quantity times unit price of the live lines of live purchase orders in Approved, Sent or Closed drawing on the line in the budget''s currency. Excluded: Proposed and Canceled orders, soft-deleted orders and lines, an order''s header tax and shipping, lines on orders in another currency (counted, never summed), approved PO change orders (app.po_change_orders amend a whole order and carry no budget line) and budget change orders (app.change_orders, counted in Approved changes and Revised). Withheld from a reader who cannot read the project''s purchase orders, never shown partial.', array[
  'budget_line_id', 'Budget line.',
  'budget_id', 'Budget of the line.',
  'project_id', 'Project of the budget.',
  'currency_code', 'Currency of the budget, and of every amount summed into committed_minor.',
  'committed_minor', 'Quantity times unit price of the counted purchase order lines, in minor units; zero when none. NULL when withheld, or when a counted line is unpriced (approval refuses unpriced lines, so this is defensive).',
  'po_line_count', 'Purchase order lines counted in committed_minor.',
  'other_currency_po_line_count', 'Lines of Approved, Sent or Closed orders in another currency drawing on the line. Counted, never summed: no silent currency conversion.',
  'is_committed_withheld', 'True when the reader cannot read the project''s purchase orders (procurement.po.read): committed_minor is then NULL rather than a partial sum.'
]);

revoke all on app.budget_line_commitments from public, anon;
grant select on app.budget_line_commitments to authenticated, service_role;
-- 1650 grants the backup login SELECT on every new relation; pg_dump never reads a view's rows.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'xos_backup') then
    revoke select on app.budget_line_commitments from xos_backup;
  end if;
end;
$$;

-- Budget line facts with committed ---------------------------------------------------------------------------------------
-- 0480's definition unchanged, with the committed columns appended after actual_minor. Existing column comments,
-- including 1611's on account_code, stay as they are; only the new columns are described.

create or replace view app.budget_line_facts with (security_invoker = true) as
select bl.id as budget_line_id, b.id as budget_id, b.project_id, b.is_baseline, b.currency_code,
  bl.line_number, bl.description, bl.line_type, bl.urid, left(bl.urid, 4) as dept_code,
  a.account_code, bl.cost_center_id, cc.code as cost_center_code, bl.grade_code, bl.element_id,
  a.extended_minor, a.is_unpriced, a.drawn_in_minor, a.drawn_out_minor, a.actual_minor,
  c.committed_minor, c.other_currency_po_line_count, c.is_committed_withheld
from app.budget_lines bl
join app.budgets b on b.id = bl.budget_id
join app.budget_line_amounts a on a.budget_line_id = bl.id
left join app.cost_centers cc on cc.id = bl.cost_center_id
left join app.budget_line_commitments c on c.budget_line_id = bl.id
where bl.deleted_at is null and b.deleted_at is null;

call private.describe('app.budget_line_facts', 'One row per live budget line with both GL dimensions, the derived account, the NULL-aware extended amount and approved spend. The grain the budget versus actual and final cost reports aggregate. Committed comes from app.budget_line_commitments: approved purchase order lines in the budget''s currency, withheld from a reader who cannot read the project''s purchase orders.', array[
  'committed_minor', 'Approved, sent and closed purchase order lines drawing on the line in the budget''s currency (app.budget_line_commitments); NULL when withheld or when a counted line is unpriced.',
  'other_currency_po_line_count', 'Purchase order lines in another currency drawing on the line: counted, never summed.',
  'is_committed_withheld', 'True when the reader cannot read the project''s purchase orders, so committed_minor is NULL rather than partial.'
]);
