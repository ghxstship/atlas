-- 2905_sign_views.sql
-- B1 Places depth on image plans (RRR-225; gap G-24; ADR 0140 D6). Where each sign stands, computed and never stored.
--
--   * app.sign_production: the furthest step each live sign has reached, from the sign's own marks and procurement's
--     facts. Ordered is a manual mark or the linked order Approved, Sent or Closed (ADR 0104 names Approved or Sent; a
--     Closed order was sent). Printed is a manual mark or the linked line received net of returns, read exactly as R7a's
--     app.po_line_supply reads it. app.po_line_supply runs as its reader, so this is a definer view (owner reads) with
--     its own row filter on places.venue.read, like app.expense_budget_lines (1622) and app.asset_unit_hire (R7a): it
--     carries no order number, vendor, quantity or price, so a sign reader learns only that a sign is ordered through
--     an order and whether it came in.
--   * app.project_signage_summary: the counts the signage page shows, per project.
--
-- Both views revoke all from public and anon, grant select to authenticated and service_role, and keep select away
-- from xos_backup (1650). Trash is synced last, so signs, venue levels and site plan shapes are in Trash once the
-- migrations have run (ADR 0110).

create view app.sign_production as
select s.id as sign_id, s.org_id, s.project_id,
  (case
    when s.placed_at is not null then 'Placed'
    when s.printed_at is not null or coalesce(rc.received, 0) > coalesce(rt.returned, 0) then 'Printed'
    when s.ordered_at is not null or po.po_state in ('Approved', 'Sent', 'Closed') then 'Ordered'
    else 'To Order'
  end)::app.sign_production_state as production_state,
  s.po_line_id is not null as ordered_via_po,
  coalesce(rc.received, 0) > coalesce(rt.returned, 0) as received,
  (s.location_text is not null or exists (
    select 1 from app.site_plan_pins pin join app.site_plans sp on sp.id = pin.site_plan_id
    where pin.id = s.site_plan_pin_id and pin.deleted_at is null and sp.deleted_at is null)) as located,
  (s.needed_by is not null and s.placed_at is null
    and s.needed_by < (now() at time zone coalesce(v.time_zone, 'UTC'))::date) as overdue
from app.signs s
join app.projects pr on pr.id = s.project_id
left join app.venues v on v.id = pr.venue_id
left join app.po_lines l on l.id = s.po_line_id and l.deleted_at is null
left join app.purchase_orders po on po.id = l.purchase_order_id and po.deleted_at is null
left join lateral (
  select sum(rl.quantity_received) as received from app.receipt_lines rl
  join app.goods_receipts g on g.id = rl.goods_receipt_id and g.deleted_at is null
  where rl.po_line_id = l.id and rl.deleted_at is null
) rc on true
left join lateral (
  select sum(r.quantity_returned) as returned from app.return_lines r
  join app.goods_returns g on g.id = r.goods_return_id and g.deleted_at is null
  join app.receipt_lines rl on rl.id = r.receipt_line_id and rl.deleted_at is null
  where rl.po_line_id = l.id and r.deleted_at is null
) rt on true
where s.deleted_at is null
  and s.project_id in (select private.project_ids_with('places.venue.read'));

call private.describe('app.sign_production', 'Where each live sign stands (G-24, ADR 0140 D6): Placed, Printed, Ordered or To Order, the furthest step reached from the sign''s own marks and from procurement''s rows. Computed, never stored. Owner-rights view with its own row filter (places.venue.read on the sign''s project): it carries no order number, vendor, quantity or price.', array[
  'sign_id', 'Sign.',
  'org_id', 'Org.',
  'project_id', 'Project.',
  'production_state', 'Placed when marked placed; Printed when marked printed or its order line came in net of returns; Ordered when marked ordered or its order is Approved, Sent or Closed; otherwise To Order.',
  'ordered_via_po', 'True when the sign is ordered through a purchase order line.',
  'received', 'True when the linked order line was received in a larger quantity than was returned.',
  'located', 'True when the sign has a location in words or a live pin on a live site plan.',
  'overdue', 'True when the needed-by day has passed in the project venue''s time zone (UTC without a venue) and the sign is not placed.'
]);
revoke all on app.sign_production from public, anon;
grant select on app.sign_production to authenticated, service_role;
revoke select on app.sign_production from xos_backup;

create view app.project_signage_summary with (security_invoker = true) as
select p.project_id, p.org_id,
  count(*) filter (where p.production_state = 'To Order')::integer as to_order,
  count(*) filter (where p.production_state = 'Ordered')::integer as ordered,
  count(*) filter (where p.production_state = 'Printed')::integer as printed,
  count(*) filter (where p.production_state = 'Placed')::integer as placed,
  count(*) filter (where p.production_state = 'Printed')::integer as unplaced,
  count(*) filter (where not p.located)::integer as unlocated,
  count(*) filter (where p.overdue)::integer as overdue
from app.sign_production p
group by p.project_id, p.org_id;

call private.describe('app.project_signage_summary', 'Signage counts per project for the signage page (G-24): signs in each production state, printed signs not yet placed, signs without a live location (placed ones included) and overdue signs. Computed from app.sign_production; runs as the reader.', array[
  'project_id', 'Project.',
  'org_id', 'Org.',
  'to_order', 'Signs to order.',
  'ordered', 'Signs ordered and not yet printed.',
  'printed', 'Signs printed and not yet placed.',
  'placed', 'Signs placed.',
  'unplaced', 'Signs printed and not yet placed.',
  'unlocated', 'Signs with no location in words and no live pin on a live plan.',
  'overdue', 'Signs past their needed-by day and not placed.'
]);
revoke all on app.project_signage_summary from public, anon;
grant select on app.project_signage_summary to authenticated, service_role;
revoke select on app.project_signage_summary from xos_backup;

select private.sync_trash_tables();
