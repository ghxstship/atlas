-- 3043_vendor_line_history.sql
-- B15 invoice line extraction (RRR-239, parity gap G-225; ADR 0154). When Aurora reads the lines of a payable invoice,
-- the panel shows what the same vendor billed or was ordered before, as hints beside each line: the price-variance badge
-- compares with them, and the budget line always comes from the person.
--
--   * app.vendor_line_history(invoice, descriptions): for each description (at most 100), the three most similar
--     earlier lines with a trigram similarity of 0.5 or more, from the same counterparty's other invoices and from the
--     purchase orders of the vendor that is that counterparty. Security invoker, so row level security decides what it
--     reads (finance.invoice.read, procurement.po.read); it never returns a budget line or a tax rate.
-- No table, column or view is added.

create or replace function app.vendor_line_history(p_invoice_id uuid, p_descriptions text[])
returns table (
  description_index integer,
  source text,
  reference text,
  line_number integer,
  issued_on date,
  description text,
  quantity numeric,
  unit_price_minor bigint,
  currency_code text,
  similarity numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  if coalesce(cardinality(p_descriptions), 0) > 100 then
    raise exception using errcode = 'XR001', hint = 'aurora_intake_item_invalid',
      message = 'aurora_intake_item_invalid: Look up at most 100 lines at a time.';
  end if;
  return query
    with inv as (
      select i.id, i.counterparty_id from app.invoices i where i.id = p_invoice_id and i.deleted_at is null
    ),
    named as (
      select n.ord::integer as idx, lower(btrim(n.text)) as probe
      from unnest(p_descriptions) with ordinality n (text, ord)
      where btrim(coalesce(n.text, '')) <> ''
    ),
    earlier as (
      select 'invoice'::text as src, i2.invoice_number as ref, l.line_number, i2.issued_on, l.description, l.quantity,
        l.unit_price_minor, i2.currency_code::text as currency
      from inv
      join app.invoices i2 on i2.counterparty_id = inv.counterparty_id and i2.id <> inv.id and i2.deleted_at is null
      join app.invoice_lines l on l.invoice_id = i2.id and l.deleted_at is null
      union all
      select 'purchase_order', po.po_number::text, pl.line_number, null::date, pl.description, pl.quantity,
        pl.unit_price_minor, po.currency_code::text
      from inv
      join app.vendors v on v.counterparty_id = inv.counterparty_id and v.deleted_at is null
      join app.purchase_orders po on po.vendor_id = v.id and po.deleted_at is null
      join app.po_lines pl on pl.purchase_order_id = po.id and pl.deleted_at is null
    )
    select nm.idx, h.src, h.ref, h.line_number, h.issued_on, h.description, h.quantity, h.unit_price_minor, h.currency, h.sim
    from named nm
    cross join lateral (
      select e.*, round(extensions.similarity(lower(btrim(e.description)), nm.probe)::numeric, 3) as sim
      from earlier e
      where extensions.similarity(lower(btrim(e.description)), nm.probe) >= 0.5
      order by extensions.similarity(lower(btrim(e.description)), nm.probe) desc, e.issued_on desc nulls last, e.ref desc, e.line_number
      limit 3
    ) h
    order by nm.idx, h.sim desc;
end;
$$;

comment on function app.vendor_line_history(uuid, text[]) is 'Hints for invoice line extraction (B15): for each description (at most 100, aurora_intake_item_invalid otherwise), the three most similar earlier lines (trigram similarity of 0.5 or more on the lower-cased text) from the invoice counterparty''s other invoices (invoice number, issue date) and from the purchase orders of its vendor (PO number), with quantity, unit price and currency. Security invoker: only rows the caller reads under row level security, and nothing when the invoice is not readable. Never returns budget_line_id or tax_rate_id.';

revoke all on function app.vendor_line_history(uuid, text[]) from public, anon;
grant execute on function app.vendor_line_history(uuid, text[]) to authenticated, service_role;
