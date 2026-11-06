-- 6543_po_payment_instalments.sql
-- B12 (RRR-236, gap G-195, and the supplier deposit and balance of G-184; ADR 0151 item 4). A purchase order carried
-- only payment_terms_days (1180), while client billing has its draws (app.billing_draws, 0321). An order now takes a
-- payment schedule: numbered instalments (a deposit, a balance) with a due date and an amount in the order's currency,
-- each billed by at most one vendor bill.
--   * The live instalments never exceed the order's known total: its lines (private.purchase_order_total, 0331) plus
--     approved PO change orders plus the header tax and shipping (1180), since a deposit and a balance are paid on the
--     gross. A NULL header charge is not stated, never unpriced; while a line is unpriced the total is unknown and the
--     check waits.
--   * A linked bill is a live, non-Canceled payable of the order's project, from the vendor's counterparty, in the
--     order's currency, not matched to another order (app.invoice_matches, 0331). Linking needs finance.invoice.read on
--     the project, which procurement.po.write alone does not give (0321).
--   * Unbilled has one meaning everywhere: invoice_id is NULL, or its bill is Canceled or soft-deleted
--     (private.po_instalment_billed). A bill that is no bill holds nothing.
--   * Instalments change freely while the order is not Closed or Canceled. A Canceled order refuses everything. A Closed
--     order allows exactly two changes, so a bill arriving after close can still be linked and an unbilled instalment
--     does not stay overdue forever: moving invoice_id from an unbilled state to a valid bill, and soft-deleting an
--     unbilled instalment. Restoring stays refused. A billed instalment keeps its amount, and an instalment stays on its
--     order.
--   * app.po_instalment_schedule reports each instalment's status (Scheduled, Invoiced, Part paid, Paid), showing the
--     bill's number and total only to a reader with finance.invoice.read on the project and the paid and scheduled
--     amounts only to a reader with finance.payment.read in the org: otherwise those columns are NULL with
--     is_invoice_withheld and is_payment_withheld, the silence rule, and without finance.payment.read the status stops
--     at Invoiced, since Part paid and Paid would read out the payments. It also gives the schedule's total and the
--     order's total, so Atlas shows the unscheduled remainder and warns when a change order took the total below the
--     schedule.

create table app.po_payment_instalments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  purchase_order_id uuid not null references app.purchase_orders (id),
  instalment_number integer not null,
  label text not null,
  due_on date not null,
  amount_minor bigint not null,
  invoice_id uuid references app.invoices (id),
  deleted_at timestamptz,
  constraint po_payment_instalments_number_positive check (instalment_number > 0),
  constraint po_payment_instalments_label_length check (char_length(btrim(label)) between 1 and 120),
  constraint po_payment_instalments_amount_positive check (amount_minor > 0)
);

create index po_payment_instalments_purchase_order_id_idx on app.po_payment_instalments (purchase_order_id);
create index po_payment_instalments_invoice_id_idx on app.po_payment_instalments (invoice_id);
create unique index po_payment_instalments_order_number_key on app.po_payment_instalments (purchase_order_id, instalment_number)
  where deleted_at is null;
create unique index po_payment_instalments_invoice_key on app.po_payment_instalments (invoice_id)
  where invoice_id is not null and deleted_at is null;

call private.install_domain_table('app.po_payment_instalments', 'app.purchase_orders', 'purchase_order_id',
  array['app.invoices', 'invoice_id']);
call private.describe('app.po_payment_instalments', 'Payment schedule of a purchase order (G-195): numbered instalments such as a deposit and a balance, each due on a date for an amount in the order''s currency and billed by at most one vendor bill. The live instalments never exceed the order''s known total including approved change orders, tax and shipping. Changed while the order is not Closed or Canceled; a Closed order only links a bill to an unbilled instalment or removes an unbilled instalment.', array[
  'purchase_order_id', 'Purchase order the instalment pays.',
  'instalment_number', 'Order of the instalment within the schedule.',
  'label', 'What the instalment is, for example Deposit or Balance.',
  'due_on', 'Date the instalment is due.',
  'amount_minor', 'Amount in minor units of the order''s currency. Fixed while a live bill is linked.',
  'invoice_id', 'Vendor bill that bills the instalment: a live payable of the order''s project, vendor and currency.'
]);

call private.install_policies('app.po_payment_instalments',
  $$purchase_order_id in (select po.id from app.purchase_orders po where po.project_id in (select private.project_ids_with('procurement.po.read')))$$,
  $$purchase_order_id in (select po.id from app.purchase_orders po where po.project_id in (select private.project_ids_with('procurement.po.write')))$$);
call private.install_default_retention('app.po_payment_instalments');
call private.install_audit_trail('app.po_payment_instalments');

-- Helpers ------------------------------------------------------------------------------------------------------------

create or replace function private.po_instalment_billed(p_invoice_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.invoices i
                 where i.id = p_invoice_id and i.deleted_at is null and i.invoice_state <> 'Canceled');
$$;

comment on function private.po_instalment_billed(uuid) is 'True when an instalment''s invoice_id names a real bill: live and not Canceled. NULL, Canceled and soft-deleted all read as unbilled. Unfiltered: read only inside definer functions.';
revoke all on function private.po_instalment_billed(uuid) from public, anon, authenticated;

create or replace function private.purchase_order_gross(p_purchase_order_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select private.purchase_order_total(po.id)
    + coalesce((select sum(c.amount_delta_minor) from app.po_change_orders c
                where c.purchase_order_id = po.id and c.deleted_at is null and c.po_change_order_state = 'Approved'), 0)
    + coalesce(po.tax_minor, 0) + coalesce(po.shipping_minor, 0)
  from app.purchase_orders po where po.id = p_purchase_order_id;
$$;

comment on function private.purchase_order_gross(uuid) is 'What an order finally costs: its lines (private.purchase_order_total) plus approved PO change orders plus header tax and shipping. A NULL header charge is not stated, never unpriced; NULL while a line is unpriced or there are no lines. Unfiltered: read only inside definer functions.';
revoke all on function private.purchase_order_gross(uuid) from public, anon, authenticated;

-- The guard --------------------------------------------------------------------------------------------------------------

create or replace function private.guard_po_payment_instalment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order app.purchase_orders;
  v_total bigint;
  v_scheduled bigint;
  v_invoice app.invoices;
  v_vendor_counterparty uuid;
  v_restored boolean := tg_op = 'UPDATE' and old.deleted_at is not null and new.deleted_at is null;
  v_old_billed boolean := false;
begin
  if tg_op = 'UPDATE' and new.purchase_order_id <> old.purchase_order_id then
    perform private.refuse('po_instalment_immutable', 'An instalment stays on its purchase order.');
  end if;
  -- The order is locked so two schedulers cannot each pass the total check.
  select * into v_order from app.purchase_orders po where po.id = new.purchase_order_id for update;
  if tg_op = 'UPDATE' then
    v_old_billed := private.po_instalment_billed(old.invoice_id);
  end if;
  if v_order.po_state = 'Canceled' then
    perform private.refuse('po_instalment_order_state', 'The payment schedule of a Canceled order does not change.');
  end if;
  -- A Closed order allows exactly two changes, each to a live unbilled instalment: a bill linked, or its removal.
  if v_order.po_state = 'Closed' and not (
       tg_op = 'UPDATE' and old.deleted_at is null and not v_old_billed and (
         (new.deleted_at is not null
          and (to_jsonb(new) - 'deleted_at' - 'updated_at' - 'updated_by') = (to_jsonb(old) - 'deleted_at' - 'updated_at' - 'updated_by'))
         or (new.deleted_at is null and new.invoice_id is not null and new.invoice_id is distinct from old.invoice_id
             and (to_jsonb(new) - 'invoice_id' - 'updated_at' - 'updated_by') = (to_jsonb(old) - 'invoice_id' - 'updated_at' - 'updated_by')))) then
    perform private.refuse('po_instalment_order_state', 'A Closed order only links a bill to an unbilled instalment or removes an unbilled instalment.');
  end if;
  if new.deleted_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and v_old_billed and new.amount_minor <> old.amount_minor then
    perform private.refuse('po_instalment_invoiced', 'A billed instalment keeps its amount; unlink the bill first.');
  end if;
  if tg_op = 'INSERT' or v_restored or new.amount_minor > old.amount_minor then
    v_total := private.purchase_order_gross(v_order.id);
    if v_total is not null then
      select coalesce(sum(i.amount_minor), 0) into v_scheduled
      from app.po_payment_instalments i
      where i.purchase_order_id = v_order.id and i.deleted_at is null and i.id <> new.id;
      if v_scheduled + new.amount_minor > v_total then
        perform private.refuse('po_instalments_exceed_order', format('The schedule would reach %s of the order''s %s.',
          v_scheduled + new.amount_minor, v_total));
      end if;
    end if;
  end if;
  if new.invoice_id is not null and (tg_op = 'INSERT' or v_restored or new.invoice_id is distinct from old.invoice_id) then
    if auth.uid() is not null and not private.can_on_project(v_order.project_id, 'finance.invoice.read') then
      raise exception using errcode = '42501', message = 'finance.invoice.read is required on the project to link a bill';
    end if;
    select * into v_invoice from app.invoices i where i.id = new.invoice_id;
    select v.counterparty_id into v_vendor_counterparty from app.vendors v where v.id = v_order.vendor_id;
    if v_invoice.id is null or v_invoice.deleted_at is not null or v_invoice.direction <> 'Payable'
       or v_invoice.invoice_state = 'Canceled' or v_invoice.project_id <> v_order.project_id
       or v_invoice.counterparty_id is distinct from v_vendor_counterparty
       or v_invoice.currency_code <> v_order.currency_code
       or exists (select 1 from app.invoice_matches m
                  where m.invoice_id = v_invoice.id and m.deleted_at is null and m.purchase_order_id <> v_order.id) then
      perform private.refuse('po_instalment_invoice', 'Link a live payable bill from the order''s vendor, on its project and in its currency, that is not matched to another order.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_po_payment_instalment() is 'Purchase order instalments (6543): nothing on a Canceled order; on a Closed order only a bill linked to, or the removal of, a live unbilled instalment, restores refused (po_instalment_order_state); unbilled is invoice_id NULL or its bill Canceled or soft-deleted (private.po_instalment_billed); fixed to their order (po_instalment_immutable); the amount fixed while a live bill is linked (po_instalment_invoiced); the live instalments within the order''s known total of lines, approved change orders, tax and shipping (po_instalments_exceed_order); and a linked bill a live, non-Canceled payable of the order''s project, vendor counterparty and currency not matched to another order (po_instalment_invoice), linked only by a person with finance.invoice.read on the project.';
revoke all on function private.guard_po_payment_instalment() from public, anon, authenticated;

create trigger t40_guard_po_payment_instalment before insert or update on app.po_payment_instalments
  for each row execute function private.guard_po_payment_instalment();

select private.sync_trash_tables();

-- The schedule -------------------------------------------------------------------------------------------------------------

create or replace function app.po_instalment_schedule(p_purchase_order_id uuid)
returns table (
  instalment_id uuid,
  instalment_number integer,
  label text,
  due_on date,
  amount_minor bigint,
  currency_code text,
  invoice_id uuid,
  invoice_number text,
  invoice_total_minor bigint,
  paid_minor bigint,
  scheduled_minor bigint,
  status text,
  is_invoice_withheld boolean,
  is_payment_withheld boolean,
  schedule_total_minor bigint,
  order_total_minor bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order app.purchase_orders;
  v_invoices boolean;
  v_payments boolean;
  v_schedule_total bigint;
  v_order_total bigint;
begin
  select * into v_order from app.purchase_orders po where po.id = p_purchase_order_id and po.deleted_at is null;
  if v_order.id is null or not private.can_on_project(v_order.project_id, 'procurement.po.read') then
    raise exception using errcode = '42501', message = 'procurement.po.read is required on the project';
  end if;
  v_invoices := private.can_on_project(v_order.project_id, 'finance.invoice.read');
  v_payments := private.has_capability(v_order.org_id, 'finance.payment.read');
  select coalesce(sum(i.amount_minor), 0)::bigint into v_schedule_total
  from app.po_payment_instalments i where i.purchase_order_id = v_order.id and i.deleted_at is null;
  v_order_total := private.purchase_order_gross(v_order.id);
  return query
  select i.id, i.instalment_number, i.label, i.due_on, i.amount_minor, v_order.currency_code::text, inv.id,
    case when v_invoices then inv.invoice_number end,
    case when v_invoices then f.total_minor end,
    case when v_payments and inv.id is not null then f.paid_minor end,
    case when v_payments and inv.id is not null then f.scheduled_minor end,
    case when inv.id is null then 'Scheduled'
         when not v_payments then 'Invoiced'
         when f.total_minor is not null and f.paid_minor >= f.total_minor then 'Paid'
         when f.paid_minor > 0 then 'Part paid'
         else 'Invoiced' end,
    not v_invoices, not v_payments, v_schedule_total, v_order_total
  from app.po_payment_instalments i
  left join app.invoices inv on inv.id = i.invoice_id and inv.deleted_at is null and inv.invoice_state <> 'Canceled'
  cross join lateral (
    select private.invoice_total(inv.id) as total_minor,
      coalesce(sum(a.amount_minor) filter (where p.payment_state = 'Approved'), 0)::bigint as paid_minor,
      coalesce(sum(a.amount_minor) filter (where p.payment_state = 'Proposed'), 0)::bigint as scheduled_minor
    from app.payment_applications a
    join app.payments p on p.id = a.payment_id and p.deleted_at is null
    where a.invoice_id = inv.id and a.deleted_at is null
  ) f
  where i.purchase_order_id = v_order.id and i.deleted_at is null
  order by i.instalment_number;
end;
$$;

comment on function app.po_instalment_schedule(uuid) is 'The payment schedule of a purchase order, for a reader with procurement.po.read on its project (42501): each live instalment with its linked bill, the bill''s total including tax, what Approved payments applied to it (paid) and what Proposed ones will (scheduled), and its status: Scheduled with no bill, Invoiced with nothing paid, Part paid, or Paid once paid reaches a known total. A Canceled or soft-deleted bill is no bill: status Scheduled and the bill columns NULL. The bill number and total need finance.invoice.read on the project and the paid and scheduled amounts finance.payment.read in the org; without them those columns are NULL and is_invoice_withheld or is_payment_withheld is true, and without finance.payment.read the status stops at Invoiced, since Part paid and Paid would read out the payments. invoice_id stays visible, as the table''s own policy shows it. schedule_total_minor is the live instalments'' sum and order_total_minor the order''s lines, approved change orders, tax and shipping, NULL while a line is unpriced.';
revoke all on function app.po_instalment_schedule(uuid) from public, anon;
grant execute on function app.po_instalment_schedule(uuid) to authenticated, service_role;
