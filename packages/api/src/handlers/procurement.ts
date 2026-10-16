/**
 * Procurement handlers (A16): RFQs with invitations and sealed responses, purchase orders with
 * lines and change orders, goods receipts, three-way matches and the catalog. Every read and write
 * runs as the caller, so row level security and A03's RPCs decide; refusals come back as 422 with
 * the rule. Shapes follow the corrections in catalog/modules/procurement.ts (ADR 0023).
 */
import {
  approvePurchaseOrder,
  decidePoChangeOrder,
  resolveInvoiceMatch,
  transitionPurchaseOrder,
  transitionRfq,
  type PoState,
  type RfqState,
} from "@xos/data/procurement";
import type { HandlerSet } from "../runtime/handler.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
import { rfqSealedResponseHandlers } from "./parts/rfq-sealed-responses.ts";
import { from, handlersFor, rpc, run, tableResource, unwrap, type Row } from "./support/table.ts";

interface TransitionBody {
  readonly expected_state: string;
  readonly to_state: string;
  readonly reason?: string;
}

const reasonOf = (body: TransitionBody, fallback: string) => body.reason ?? fallback;

const rfqs = tableResource("rfqs");
const purchaseOrders = tableResource("purchaseOrders");
const poChangeOrders = tableResource("poChangeOrders");

const poLines = tableResource("poLines", {
  // A line without a number goes after the order's last line.
  beforeCreate: async (body, { db }) => {
    if (body["line_number"] !== undefined) return {};
    const last = await run<{ line_number: number }[]>(
      from(db, "po_lines")
        .select("line_number")
        .eq("purchase_order_id", body["purchase_order_id"])
        .is("deleted_at", null)
        .order("line_number", { ascending: false })
        .limit(1),
    );
    return { line_number: (last[0]?.line_number ?? 0) + 1 };
  },
});

const invoiceMatches = tableResource("invoiceMatches", {
  derived: ["matched", "variance_minor"],
  // Variance and agreement are derived by app.invoice_match_results (0491).
  toContract: async (row, { db }) => {
    if (row["id"] === undefined) return row;
    const result = await run<{ is_matched: boolean | null; variance_minor: number | null } | null>(
      from(db, "invoice_match_results")
        .select("is_matched, variance_minor")
        .eq("invoice_match_id", row["id"])
        .maybeSingle(),
    );
    return {
      ...row,
      matched: result?.is_matched ?? false,
      variance_minor: result?.variance_minor ?? null,
    };
  },
});

export const handlers = defineHandlers("Procurement", {
  ...handlersFor("Procurement", rfqs),
  ...handlersFor("Procurement", tableResource("rfqInvitations")),
  ...handlersFor(
    "Procurement",
    tableResource("rfqResponses", { orgColumn: true, verbs: ["list", "get"] }),
  ),
  ...(rfqSealedResponseHandlers as unknown as HandlerSet<"Procurement">),
  ...handlersFor("Procurement", tableResource("rfqResponseLines")),
  ...handlersFor("Procurement", purchaseOrders),
  ...handlersFor("Procurement", poLines),
  ...handlersFor("Procurement", poChangeOrders),
  ...handlersFor("Procurement", tableResource("goodsReceipts")),
  ...handlersFor("Procurement", tableResource("receiptLines")),
  ...handlersFor("Procurement", invoiceMatches),
  ...handlersFor("Procurement", tableResource("catalogBindings")),
  ...handlersFor("Procurement", tableResource("vendorProducts")),

  // RFQ lifecycle: issuing needs an invitation; closing unseals responses (app.transition_rfq).
  "rfqs.issue": async ({ params }, context) => {
    const rfq = await rfqs.read(context, params.id, ["id", "rfq_state"]);
    unwrap(
      await transitionRfq(context.db, {
        id: params.id,
        expected: rfq["rfq_state"] as RfqState,
        next: "Issued",
        reason: "Issued to the invited vendors.",
      }),
    );
    return ok((await rfqs.read(context, params.id)) as never);
  },

  "rfqs.transition": async ({ params, body }, context) => {
    await rfqs.read(context, params.id, ["id"]);
    const b = body as TransitionBody;
    unwrap(
      await transitionRfq(context.db, {
        id: params.id,
        expected: b.expected_state as RfqState,
        next: b.to_state as RfqState,
        reason: reasonOf(b, "Changed through the API."),
      }),
    );
    return ok((await rfqs.read(context, params.id)) as never);
  },

  // Purchase orders: approval under spend authority, never by the creator (app.approve_purchase_order).
  "purchaseOrders.approve": async ({ params, body }, context) => {
    await purchaseOrders.read(context, params.id, ["id"]);
    const reason = (body as { reason: string }).reason;
    // A first approval above the dual threshold leaves the order Proposed for a second approver.
    unwrap(await approvePurchaseOrder(context.db, params.id, reason));
    return ok((await purchaseOrders.read(context, params.id)) as never);
  },

  "purchaseOrders.transition": async ({ params, body }, context) => {
    await purchaseOrders.read(context, params.id, ["id"]);
    const b = body as TransitionBody;
    unwrap(
      await transitionPurchaseOrder(context.db, {
        id: params.id,
        expected: b.expected_state as PoState,
        next: b.to_state as PoState,
        reason: reasonOf(b, "Changed through the API."),
      }),
    );
    return ok((await purchaseOrders.read(context, params.id)) as never);
  },

  // The vendor's acknowledgment of a sent order (A28b's app.acknowledge_purchase_order, 0766).
  "purchaseOrders.acknowledge": async ({ params }, context) => {
    await run(rpc(context.db, "acknowledge_purchase_order", { p_purchase_order_id: params.id }));
    return ok((await purchaseOrders.read(context, params.id)) as never);
  },

  "poChangeOrders.approve": async ({ params, body }, context) => {
    await poChangeOrders.read(context, params.id, ["id"]);
    const reason = (body as { reason: string }).reason;
    unwrap(await decidePoChangeOrder(context.db, { id: params.id, decision: "Approved", reason }));
    return ok((await poChangeOrders.read(context, params.id)) as never);
  },

  "poChangeOrders.reject": async ({ params, body }, context) => {
    await poChangeOrders.read(context, params.id, ["id"]);
    const reason = (body as { reason: string }).reason;
    unwrap(await decidePoChangeOrder(context.db, { id: params.id, decision: "Rejected", reason }));
    return ok((await poChangeOrders.read(context, params.id)) as never);
  },

  // A mismatch is accepted once, by someone other than the matcher (guard_invoice_match).
  "invoiceMatches.resolve": async ({ params, body }, context) => {
    await invoiceMatches.read(context, params.id, ["id"]);
    unwrap(
      await resolveInvoiceMatch(context.db, params.id, (body as Row)["resolution_note"] as string),
    );
    return ok((await invoiceMatches.read(context, params.id)) as never);
  },
});
