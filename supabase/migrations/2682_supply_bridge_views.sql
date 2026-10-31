-- 2682_supply_bridge_views.sql
-- R7a Supply bridge (RRR-183, ADR 0104). Two reader views over the links 2681 adds, both computed and never stored,
-- both running as the reader so procurement's and assets' row level security decide what each person sees:
--
--   * app.po_line_supply: per order line, what was ordered, whether the vendor acknowledged the order, what came in,
--     what went back and whether a rental's off-hire is due. No prices.
--   * app.asset_unit_provenance: per unit, the receipt, order line and order it arrived on, with the vendor and the
--     unit price. The procurement policies hide the row from anyone without procurement.po.read, so cost never
--     reaches an asset-only reader.
--
-- Each view revokes all from public and anon, grants select to authenticated and service_role, and keeps select away
-- from the read-only backup login xos_backup, as 2370 does (1650 grants it every new relation by default).

create view app.po_line_supply with (security_invoker = on) as
select l.id as po_line_id, l.org_id, po.project_id, l.purchase_order_id, po.po_number, po.po_state, l.element_id,
  l.acquisition_kind, l.hire_period, l.quantity as quantity_ordered,
  exists (select 1 from app.po_acknowledgments a where a.purchase_order_id = po.id and a.deleted_at is null) as acknowledged,
  coalesce(rc.received, 0) as quantity_received,
  coalesce(rt.returned, 0) as quantity_returned,
  coalesce(un.units, 0) as units_received,
  (l.acquisition_kind = 'Rental' and upper(l.hire_period) <= now()
   and coalesce(rc.received, 0) > coalesce(rt.returned, 0)) as off_hire_due
from app.po_lines l
join app.purchase_orders po on po.id = l.purchase_order_id and po.deleted_at is null
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
left join lateral (
  select count(*)::integer as units from app.asset_units u
  join app.receipt_lines rl on rl.id = u.receipt_line_id and rl.deleted_at is null
  where rl.po_line_id = l.id and u.deleted_at is null
) un on true
where l.deleted_at is null;

call private.describe('app.po_line_supply', 'Supply progress of each purchase order line (R7a, ADR 0104), read from the tables that own each step: ordered (the line), acknowledged (app.po_acknowledgments), received (app.receipt_lines), returned (app.return_lines) and the units that came in. Computed, never stored, and without prices. Runs as the reader: procurement.po.read decides the rows, and units_received counts only units the reader may read.', array[
  'po_line_id', 'Purchase order line.',
  'org_id', 'Org.',
  'project_id', 'Project of the order.',
  'purchase_order_id', 'Purchase order.',
  'po_number', 'Order number from the project sequence.',
  'po_state', 'Order state: Approved or Sent is Ordered.',
  'element_id', 'Catalog element ordered, when one applies.',
  'acquisition_kind', 'Purchase or Rental.',
  'hire_period', 'Rental lines: when the hire starts and ends.',
  'quantity_ordered', 'Quantity ordered.',
  'acknowledged', 'True once the vendor acknowledged the order.',
  'quantity_received', 'Quantity received on live receipt lines.',
  'quantity_returned', 'Quantity returned to the vendor against those receipt lines.',
  'units_received', 'Live asset units that arrived on the line''s receipt lines.',
  'off_hire_due', 'True for a rental line whose hire has ended while more was received than returned.'
]);
revoke all on app.po_line_supply from public, anon;
grant select on app.po_line_supply to authenticated, service_role;
revoke select on app.po_line_supply from xos_backup;

create view app.asset_unit_provenance with (security_invoker = on) as
select u.id as asset_unit_id, u.org_id, u.receipt_line_id, g.id as goods_receipt_id, g.received_at, l.id as po_line_id,
  po.id as purchase_order_id, po.po_number, po.project_id, po.vendor_id, l.acquisition_kind, l.hire_period,
  l.unit_price_minor, po.currency_code
from app.asset_units u
join app.receipt_lines rl on rl.id = u.receipt_line_id and rl.deleted_at is null
join app.goods_receipts g on g.id = rl.goods_receipt_id and g.deleted_at is null
join app.po_lines l on l.id = rl.po_line_id
join app.purchase_orders po on po.id = g.purchase_order_id
where u.deleted_at is null;

call private.describe('app.asset_unit_provenance', 'Where each asset unit came from (R7a, ADR 0104): the receipt, order line and purchase order it arrived on, with the vendor, the acquisition kind and the unit price. Derived through the unit''s receipt line, never stored on the unit. Runs as the reader, so a person without procurement.po.read on the order''s project reads no row and never sees cost.', array[
  'asset_unit_id', 'Asset unit.',
  'org_id', 'Org.',
  'receipt_line_id', 'Receipt line the unit arrived on.',
  'goods_receipt_id', 'Goods receipt of that line.',
  'received_at', 'When the goods arrived.',
  'po_line_id', 'Purchase order line received.',
  'purchase_order_id', 'Purchase order.',
  'po_number', 'Order number from the project sequence.',
  'project_id', 'Project that bought or hired the unit.',
  'vendor_id', 'Vendor that supplied the unit.',
  'acquisition_kind', 'Purchase or Rental.',
  'hire_period', 'Rental lines: when the hire starts and ends.',
  'unit_price_minor', 'Unit price in minor units of the order currency; NULL while unpriced.',
  'currency_code', 'ISO 4217 currency of the order.'
]);
revoke all on app.asset_unit_provenance from public, anon;
grant select on app.asset_unit_provenance to authenticated, service_role;
revoke select on app.asset_unit_provenance from xos_backup;
