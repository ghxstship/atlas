import type { SupabaseClient } from "@supabase/supabase-js";
import { receivableOrders, type ReceivableOrder } from "../domain/scan";

/**
 * The project's orders the Receive against an order sheet offers (R7a), read online over REST under the viewer's
 * row level security: Approved or Sent purchase orders, their lines, each line's progress (app.po_line_supply) and
 * the org's asset classes, so serialized lines take scanned tags. Null when offline or refused; the sheet then says
 * it needs a connection, and scans outside it still queue to intake.
 */
export async function loadReceivableOrders(
  client: SupabaseClient,
  projectId: string,
): Promise<ReceivableOrder[] | null> {
  try {
    const orders = await client
      .from("purchase_orders")
      .select(
        "id, po_number, po_state, vendor:vendors(counterparty:counterparties(counterparty_name))",
      )
      .eq("project_id", projectId)
      .in("po_state", ["Approved", "Sent"])
      .is("deleted_at", null);
    if (orders.error) return null;
    const ids = (orders.data ?? []).map((o) => String(o.id));
    if (ids.length === 0) return [];
    const [lines, supply, classes] = await Promise.all([
      client
        .from("po_lines")
        .select("id, purchase_order_id, line_number, description, element_id")
        .in("purchase_order_id", ids)
        .is("deleted_at", null),
      client
        .from("po_line_supply")
        .select("po_line_id, quantity_ordered, quantity_received")
        .in("purchase_order_id", ids),
      client.from("asset_classes").select("element_id").is("deleted_at", null),
    ]);
    if (lines.error || supply.error) return null;
    return receivableOrders(
      (orders.data ?? []).map((o) => {
        const vendor = o.vendor as unknown as {
          counterparty: { counterparty_name: string | null } | null;
        } | null;
        return {
          id: String(o.id),
          po_number: Number(o.po_number),
          po_state: String(o.po_state),
          vendor_name: vendor?.counterparty?.counterparty_name ?? null,
        };
      }),
      (lines.data ?? []) as {
        id: string;
        purchase_order_id: string;
        line_number: number;
        description: string;
        element_id: string | null;
      }[],
      (supply.data ?? []) as {
        po_line_id: string;
        quantity_ordered: number;
        quantity_received: number;
      }[],
      // A receiver who cannot read assets receives plain quantities.
      classes.error ? [] : (classes.data ?? []).map((c) => String(c.element_id)),
    );
  } catch {
    return null;
  }
}
