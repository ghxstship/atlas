-- 0491_invoice_match_results_access.sql
-- A16 (ADR 0022 range 0490 to 0499). app.invoice_match_results (0331) called
-- private.invoice_match_variance and private.invoice_match_is_clean, whose execute privilege is
-- revoked from authenticated, so every signed-in read failed with 42501 and the three-way match page
-- could not show a variance. Granting those definer functions would let anyone price any match, and
-- they re-read the scanned table (the ADR 0016 crash rule). The view now derives the same values
-- from rows the caller may read: the invoice side from app.invoice_totals (subtotal plus tax, NULL
-- while unpriced) and the received side from the receipt's lines at purchase order prices. It stays
-- security_invoker, so row level security decides every row and no other tenant's data is reachable.

create or replace view app.invoice_match_results with (security_invoker = true) as
select m.id as invoice_match_id, m.invoice_id, m.purchase_order_id, m.goods_receipt_id,
  (t.subtotal_minor + t.tax_minor) - received.value_minor as variance_minor,
  coalesce((t.subtotal_minor + t.tax_minor) - received.value_minor = 0, false)
    and i.counterparty_id = v.counterparty_id
    and i.currency_code = po.currency_code as is_matched,
  m.resolved_at is not null as is_resolved
from app.invoice_matches m
join app.invoices i on i.id = m.invoice_id
join app.purchase_orders po on po.id = m.purchase_order_id
join app.vendors v on v.id = po.vendor_id
left join app.invoice_totals t on t.invoice_id = m.invoice_id
left join lateral (
  select sum(private.extended_minor(rl.quantity_received, pl.unit_price_minor))::bigint as value_minor
  from app.receipt_lines rl
  join app.po_lines pl on pl.id = rl.po_line_id
  where rl.goods_receipt_id = m.goods_receipt_id and rl.deleted_at is null
) received on true
where m.deleted_at is null;

call private.describe('app.invoice_match_results', 'Three-way match results, derived from rows the caller may read: variance between the invoice total (subtotal plus tax) and the value received at order prices, whether vendor, currency and amount agree, and whether a mismatch was accepted.', array[
  'invoice_match_id', 'Match.',
  'invoice_id', 'Invoice.',
  'purchase_order_id', 'Purchase order.',
  'goods_receipt_id', 'Receipt.',
  'variance_minor', 'Invoice total minus value received in minor units; NULL when either side is unpriced.',
  'is_matched', 'True when amount, vendor and currency agree.',
  'is_resolved', 'True when a mismatch was accepted with a resolution.'
]);
revoke all on app.invoice_match_results from public, anon;
grant select on app.invoice_match_results to authenticated, service_role;
