/**
 * Sealed RFQ response handler (A33): `rfqResponses.create` records the response and its lines in one
 * call to app.record_rfq_response (A16, 0493) and answers a receipt, because a sealed response cannot
 * be read back until the RFQ closes. handlers/procurement.ts spreads it.
 */
import type { ErasedHandler } from "../../runtime/handler.ts";
import { created } from "../../runtime/handler.ts";
import { from, rpc, run, type Row } from "../support/table.ts";

/** RFQ states in which responses are readable (0331: closing unseals them). */
const UNSEALED = new Set(["Closed", "Awarded"]);

export const rfqSealedResponseHandlers: Readonly<Record<string, ErasedHandler>> = {
  "rfqResponses.create": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const lines = (body["lines"] ?? []) as readonly Row[];
    const id = await run<string>(
      rpc(context.db, "record_rfq_response", {
        p_rfq_id: body["rfq_id"],
        p_vendor_id: body["vendor_id"],
        p_valid_until: body["valid_until"] ?? null,
        p_currency_code: body["currency_code"],
        p_lines: lines.map((line) => ({
          description: line["description"],
          element_id: line["element_id"] ?? null,
          quantity: line["quantity"] ?? 1,
          unit_price_minor: line["unit_price_minor"] ?? null,
        })),
      }),
    );
    const rfq = await run<{ rfq_state: string } | null>(
      from(context.db, "rfqs").select("rfq_state").eq("id", body["rfq_id"]).maybeSingle(),
    );
    return created({
      rfq_response_id: id,
      rfq_id: body["rfq_id"],
      vendor_id: body["vendor_id"],
      line_count: lines.length,
      sealed: rfq === null || !UNSEALED.has(rfq.rfq_state),
    });
  },
};
