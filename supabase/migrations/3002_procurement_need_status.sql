-- 3002_procurement_need_status.sql
-- B11 Need status (RRR-235, G-180, ADR 0104 amendment): computed from order lines, never stored.
--
--   * app.procurement_need_status: a reader's view of each need. Ordered follows ADR 0104 (Approved or Sent) and adds
--     Closed: a closed order delivered its goods, and they still count as bought. Proposed lines show only as drafted;
--     Canceled orders count nothing. A return lowers ordered unless the goods were never short: Off Hire ends a hire
--     that was ordered in full, and Over Delivery sends back what was never ordered.
--   * private.need_requested_quantity and private.need_effective_during answer a buyer who cannot read the allocations
--     (no advancing.packet.read): a true number and a true window, and no names.
--   * app.allocations_ready_to_consolidate: an owner-rights view for holders of both capabilities, with holder names
--     from app.allocation_holders, never from app.people.

create or replace function private.need_requested_quantity(p_need_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(a.quantity + coalesce((
      select sum(k.quantity) from app.advance_allocations k
      where k.parent_allocation_id = a.id and k.origin = 'Split' and k.deleted_at is null
        and k.allocation_state in ('Requested', 'Approved')), 0)), 0)
  from app.procurement_need_requests l
  join app.procurement_needs n on n.id = l.procurement_need_id
  join app.advance_allocations a on a.id = l.advance_allocation_id
  where l.procurement_need_id = p_need_id and l.deleted_at is null and a.deleted_at is null
    and a.allocation_state in ('Requested', 'Approved')
    and private.can_on_project(n.project_id, 'procurement.po.read');
$$;
comment on function private.need_requested_quantity(uuid) is 'What was asked for on a need (B11, G-180): its live Requested and Approved linked allocations plus their live Split children. A sum only, for procurement.po.read on the need''s project, so a buyer without advancing.packet.read gets a true number and no names. Granted to signed-in callers because app.procurement_need_status, a security_invoker view, reads it.';
revoke all on function private.need_requested_quantity(uuid) from public, anon;
grant execute on function private.need_requested_quantity(uuid) to authenticated, service_role;

create or replace function private.need_window(p_need_id uuid)
returns tstzrange
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(n.needed_during, (
    select tstzrange(min(lower(a.needed_during)), max(upper(a.needed_during)), '[)')
    from app.procurement_need_requests l
    join app.advance_allocations a on a.id = l.advance_allocation_id
    where l.procurement_need_id = n.id and l.deleted_at is null and a.deleted_at is null
      and a.allocation_state in ('Requested', 'Approved')))
  from app.procurement_needs n
  where n.id = p_need_id;
$$;
comment on function private.need_window(uuid) is 'When a need is needed (B11, G-180): its own window, else the span of its live Requested and Approved linked allocations; NULL when it has neither.';
revoke all on function private.need_window(uuid) from public, anon, authenticated;

create or replace function private.need_effective_during(p_need_id uuid)
returns tstzrange
language sql
stable
security definer
set search_path = ''
as $$
  select private.need_window(n.id)
  from app.procurement_needs n
  where n.id = p_need_id and private.can_on_project(n.project_id, 'procurement.po.read');
$$;
comment on function private.need_effective_during(uuid) is 'private.need_window for procurement.po.read on the need''s project, so a buyer without advancing.packet.read still reads when it is needed. Granted to signed-in callers because app.procurement_need_status, a security_invoker view, reads it.';
revoke all on function private.need_effective_during(uuid) from public, anon;
grant execute on function private.need_effective_during(uuid) to authenticated, service_role;

create or replace function private.need_project_facts(p_project_id uuid)
returns table (project_key text, time_zone text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.project_key, p.time_zone from app.projects p
  where p.id = p_project_id and private.can_on_project(p.id, 'procurement.po.read');
$$;
comment on function private.need_project_facts(uuid) is 'A project''s key and time zone for app.procurement_need_status, for procurement.po.read on the project: a buyer who holds it alone may not read app.projects. Granted to signed-in callers because that security_invoker view reads it.';
revoke all on function private.need_project_facts(uuid) from public, anon;
grant execute on function private.need_project_facts(uuid) to authenticated, service_role;

create view app.procurement_need_status with (security_invoker = true) as
select x.need_id, x.org_id, x.project_id, x.project_key, x.time_zone, x.need_number, x.description, x.quantity, x.unit_basis, x.asset_class_id,
  x.element_id, x.note, x.created_at, x.requested_quantity, x.effective_during, x.drafted_quantity, x.ordered_quantity, x.received_quantity,
  case when x.ordered_quantity = 0 then 'Needs Ordered'
       when x.ordered_quantity < x.quantity then 'Short'
       when x.ordered_quantity = x.quantity then 'On Order'
       else 'Excess' end as need_status
from (
  select n.id as need_id, n.org_id, n.project_id, p.project_key, p.time_zone, n.need_number, n.description, n.quantity, n.unit_basis, n.asset_class_id,
    n.element_id, n.note, n.created_at,
    private.need_requested_quantity(n.id) as requested_quantity,
    private.need_effective_during(n.id) as effective_during,
    coalesce((select sum(l.quantity) from app.po_lines l
      join app.purchase_orders po on po.id = l.purchase_order_id and po.deleted_at is null and po.po_state = 'Proposed'
      where l.procurement_need_id = n.id and l.deleted_at is null), 0) as drafted_quantity,
    coalesce((select sum(greatest(l.quantity - coalesce((
        select sum(rt.quantity_returned) from app.return_lines rt
        join app.goods_returns g on g.id = rt.goods_return_id and g.deleted_at is null and g.return_reason not in ('Off Hire', 'Over Delivery')
        join app.receipt_lines rl on rl.id = rt.receipt_line_id and rl.deleted_at is null
        where rl.po_line_id = l.id and rt.deleted_at is null), 0), 0))
      from app.po_lines l
      join app.purchase_orders po on po.id = l.purchase_order_id and po.deleted_at is null and po.po_state in ('Approved', 'Sent', 'Closed')
      where l.procurement_need_id = n.id and l.deleted_at is null), 0) as ordered_quantity,
    coalesce((select sum(rl.quantity_received) from app.po_lines l
      join app.purchase_orders po on po.id = l.purchase_order_id and po.deleted_at is null and po.po_state in ('Approved', 'Sent', 'Closed')
      join app.receipt_lines rl on rl.po_line_id = l.id and rl.deleted_at is null
      join app.goods_receipts g on g.id = rl.goods_receipt_id and g.deleted_at is null
      where l.procurement_need_id = n.id and l.deleted_at is null), 0) as received_quantity
  from app.procurement_needs n
  cross join lateral private.need_project_facts(n.project_id) p
  where n.deleted_at is null
) x;

call private.describe('app.procurement_need_status', 'Each live need with what was asked for and what is ordered (B11, G-180, ADR 0104 amendment): computed, never stored, and it runs as the reader.', array[
  'need_id', 'Need.',
  'org_id', 'Org.',
  'project_id', 'Project.',
  'project_key', 'Project key, for the display key.',
  'time_zone', 'Time zone of the project, for typing and reading the window.',
  'need_number', 'The need''s number in the project.',
  'description', 'What is needed.',
  'quantity', 'How much the event will get.',
  'unit_basis', 'Unit of the quantity.',
  'asset_class_id', 'Asset class named, when one is.',
  'element_id', 'Catalog element named, when one is.',
  'note', 'What the buyer noted.',
  'created_at', 'When the need was added.',
  'requested_quantity', 'Live Requested and Approved linked allocations plus their live Split children.',
  'effective_during', 'Its own window, else the span of those allocations.',
  'drafted_quantity', 'On lines of Proposed orders: shown, never counted.',
  'ordered_quantity', 'On lines of Approved, Sent or Closed orders, less returns other than Off Hire and Over Delivery, each line at least 0.',
  'received_quantity', 'Received on those lines.',
  'need_status', 'Needs Ordered (none ordered), Short (ordered below quantity), On Order (equal) or Excess (above).'
]);
revoke all on app.procurement_need_status from public, anon;
grant select on app.procurement_need_status to authenticated, service_role;
revoke select on app.procurement_need_status from xos_backup;

create view app.allocations_ready_to_consolidate as
select a.id as allocation_id, a.org_id, a.project_id, a.asset_class_id, c.name as class_name, a.quantity, a.needed_during,
  a.allocation_state, a.engagement_id, a.roster_entry_id, h.holder_name, h.party_name
from app.advance_allocations a
join app.asset_classes c on c.id = a.asset_class_id
left join app.allocation_holders h on h.project_id = a.project_id and h.engagement_id is not distinct from
    coalesce(a.engagement_id, (select r.engagement_id from app.engagement_roster_entries r where r.id = a.roster_entry_id))
  and h.roster_entry_id is not distinct from a.roster_entry_id
where a.deleted_at is null and a.allocation_state in ('Requested', 'Approved')
  and a.project_id in (select private.project_ids_with('advancing.packet.read'))
  and a.project_id in (select private.project_ids_with('procurement.po.read'))
  and not exists (select 1 from app.procurement_need_requests l where l.advance_allocation_id = a.id and l.deleted_at is null)
  -- Neither a child of a linked pool nor a pool with a linked child, so sums never double.
  and not exists (select 1 from app.procurement_need_requests l where l.advance_allocation_id = a.parent_allocation_id and l.deleted_at is null)
  and not exists (select 1 from app.procurement_need_requests l
                  join app.advance_allocations k on k.id = l.advance_allocation_id
                  where k.parent_allocation_id = a.id and l.deleted_at is null);

call private.describe('app.allocations_ready_to_consolidate', 'Equipment requests no need holds yet (B11, G-180): live Requested or Approved allocations with an asset class and no live link, whose pool or Split children are not linked either. A security definer view filtered to holders of both advancing.packet.read and procurement.po.read on the project; holder names come from app.allocation_holders.', array[
  'allocation_id', 'Allocation.',
  'org_id', 'Org.',
  'project_id', 'Project.',
  'asset_class_id', 'Asset class asked for.',
  'class_name', 'Name of the class.',
  'quantity', 'Quantity asked for.',
  'needed_during', 'When it is needed.',
  'allocation_state', 'Requested or Approved.',
  'engagement_id', 'Party pool holding it; NULL for a person.',
  'roster_entry_id', 'Roster entry holding it; NULL for a pool.',
  'holder_name', 'The party''s or person''s name.',
  'party_name', 'The supplying account''s name.'
]);
revoke all on app.allocations_ready_to_consolidate from public, anon;
grant select on app.allocations_ready_to_consolidate to authenticated, service_role;
revoke select on app.allocations_ready_to_consolidate from xos_backup;
