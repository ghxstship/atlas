/**
 * Procurement handlers (A16): RFQs with invitations and sealed responses, purchase orders with
 * lines and change orders, goods receipts, three-way matches and the catalog. Every read and write
 * runs as the caller, so row level security and A03's RPCs decide; refusals come back as 422 with
 * the rule. Shapes follow the corrections in catalog/modules/procurement.ts (ADR 0023).
 */
import type { XosClient } from "@xos/data";
import {
  approvePurchaseOrder,
  decidePoChangeOrder,
  getHireWindowWarnings,
  hirePeriodLiteral,
  parseHirePeriod,
  recordGoodsReceipt,
  recordGoodsReturn,
  resolveInvoiceMatch,
  transitionPurchaseOrder,
  transitionRfq,
  type GoodsReturnReason,
  type PoState,
  type RfqState,
} from "@xos/data/procurement";
import type { ErasedHandler, HandlerSet } from "../runtime/handler.ts";
import { requireOrg } from "../runtime/context.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
import { rfqSealedResponseHandlers } from "./parts/rfq-sealed-responses.ts";
import { fieldHistory } from "./parts/bulk-edit-and-history.ts";
import { mergeBy, sumMinor, withTransition } from "./support/enrich.ts";
import {
  from,
  groupBy,
  handlersFor,
  keysOf,
  rpc,
  run,
  tableResource,
  unwrap,
  type Row,
} from "./support/table.ts";

interface TransitionBody {
  readonly expected_state: string;
  readonly to_state: string;
  readonly reason?: string;
}

const reasonOf = (body: TransitionBody, fallback: string) => body.reason ?? fallback;

const rfqs = tableResource("rfqs");
/**
 * The invoiced and paid amounts of each order: the subtotals and applied payments (app.invoice_totals) of the
 * distinct live invoices matched to it (app.invoice_matches), NULL-aware (A54-002).
 */
async function withInvoicing(db: XosClient, rows: Row[]): Promise<Row[]> {
  const matches = await groupBy(
    from(db, "invoice_matches")
      .select("purchase_order_id, invoice_id")
      .in("purchase_order_id", keysOf(rows, "id"))
      .is("deleted_at", null),
    "purchase_order_id",
  );
  const invoiceIds = [...new Set([...matches.values()].flat().map((m) => String(m["invoice_id"])))];
  const totals =
    invoiceIds.length === 0
      ? new Map<string, Row[]>()
      : await groupBy(
          from(db, "invoice_totals")
            .select("invoice_id, subtotal_minor, applied_minor")
            .in("invoice_id", invoiceIds),
          "invoice_id",
        );
  return mergeBy(rows, "id", matches, (group) => {
    const invoices = [...new Set(group.map((m) => String(m["invoice_id"])))]
      .map((id) => totals.get(id)?.[0])
      .filter((t): t is Row => t !== undefined);
    return {
      invoiced_minor: sumMinor(invoices, "subtotal_minor"),
      paid_minor: sumMinor(invoices, "applied_minor"),
    };
  });
}

const purchaseOrders = tableResource("purchaseOrders", {
  derived: ["sent_at", "invoiced_minor", "paid_minor"],
  // The issue date from the transition ledger, and the invoiced and paid amounts (A54-002).
  enrich: async (rows, { db }) =>
    withInvoicing(
      db,
      await withTransition(db, rows, {
        table: "purchase_order_state_transitions",
        fk: "purchase_order_id",
        toState: "Sent",
        at: "sent_at",
      }),
    ),
});
const poChangeOrders = tableResource("poChangeOrders");

const HIRE_FIELDS = ["hire_starts_at", "hire_ends_at"] as const;

/**
 * The hire period of a line being written (R7a, 2681): the contract's two instants become one tstzrange, kept from
 * the current line where the body leaves one out, and cleared on a Purchase line. The database refuses a Rental line
 * without both bounds (po_lines_hire_period_kind).
 */
function hirePeriodOf(body: Row, current: Row = {}): Row {
  const touched = body["acquisition_kind"] !== undefined || HIRE_FIELDS.some((f) => f in body);
  if (!touched) return {};
  const kind = (body["acquisition_kind"] ?? current["acquisition_kind"] ?? "Purchase") as string;
  const pick = (f: (typeof HIRE_FIELDS)[number]) =>
    (f in body ? body[f] : current[f]) as string | null | undefined;
  return {
    hire_period:
      kind === "Rental" ? hirePeriodLiteral(pick("hire_starts_at"), pick("hire_ends_at")) : null,
  };
}

/** The contract body without the two hire instants, which are no columns. */
function withoutHireFields<R extends { body: unknown }>(request: R): R {
  const sent = (request.body ?? {}) as Row;
  const body = Object.fromEntries(
    Object.entries(sent).filter(([f]) => !(HIRE_FIELDS as readonly string[]).includes(f)),
  );
  // hire_period is no create or update field, so only beforeCreate and beforeUpdate below write it.
  return { ...request, body: { ...body, ...hirePeriodOf(sent), hire_fields_sent: sent } };
}

const poLines = tableResource("poLines", {
  derived: [...HIRE_FIELDS],
  extraColumns: ["hire_period"],
  toContract: (row) => {
    const hire = parseHirePeriod(row["hire_period"] as string | null);
    return { ...row, hire_starts_at: hire.startsAt, hire_ends_at: hire.endsAt };
  },
  // A line without a number goes after the order's last line.
  beforeCreate: async (body, { db }) => {
    const period = "hire_period" in body ? { hire_period: body["hire_period"] } : {};
    if (body["line_number"] !== undefined) return period;
    const last = await run<{ line_number: number }[]>(
      from(db, "po_lines")
        .select("line_number")
        .eq("purchase_order_id", body["purchase_order_id"])
        .is("deleted_at", null)
        .order("line_number", { ascending: false })
        .limit(1),
    );
    return { ...period, line_number: (last[0]?.line_number ?? 0) + 1 };
  },
  beforeUpdate: (body, current) => hirePeriodOf((body["hire_fields_sent"] ?? {}) as Row, current),
});

function poLineHandler(op: string): ErasedHandler {
  const handler = poLines.handlers[op];
  if (handler === undefined) throw new Error(`${op} has no table handler.`);
  return handler;
}

/** Splits a range column of a view row into two instants. */
function rangeFields(row: Row, column: string, from: string, to: string): Row {
  const range = parseHirePeriod(row[column] as string | null);
  return { ...row, [from]: range.startsAt, [to]: range.endsAt };
}

const poLineHireWarnings = tableResource("poLineHireWarnings", {
  softDelete: false,
  key: "warning",
  derived: [...HIRE_FIELDS, "site_opens_at", "site_closes_at"],
  extraColumns: ["hire_period", "site_window"],
  toContract: (row) =>
    rangeFields(
      rangeFields(row, "hire_period", "hire_starts_at", "hire_ends_at"),
      "site_window",
      "site_opens_at",
      "site_closes_at",
    ),
  scope: (q, context) => (context.org === null ? q : q.eq("org_id", context.org.id)),
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
  // The two hire instants of the contract are one tstzrange column (R7a).
  "poLines.create": async (request, context) =>
    (await poLineHandler("poLines.create")(withoutHireFields(request), context)) as never,
  "poLines.update": async (request, context) =>
    (await poLineHandler("poLines.update")(withoutHireFields(request), context)) as never,
  ...handlersFor("Procurement", poChangeOrders),
  ...handlersFor("Procurement", tableResource("goodsReceipts")),
  ...handlersFor("Procurement", tableResource("receiptLines")),
  ...handlersFor("Procurement", tableResource("goodsReturns")),
  ...handlersFor("Procurement", tableResource("returnLines")),
  ...handlersFor("Procurement", poLineHireWarnings),
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

  // The supply bridge (R7a): one receipt or return event per request. The runtime replays a repeated
  // Idempotency-Key from its ledger, so the event id is minted once, on the first request.
  "purchaseOrders.receive": async ({ params, body }, context) => {
    await purchaseOrders.read(context, params.id, ["id"]);
    const result = unwrap(
      await recordGoodsReceipt(context.db, {
        eventId: crypto.randomUUID(),
        purchaseOrderId: params.id,
        note: body.note ?? null,
        lines: body.lines.map((l) => ({
          poLineId: l.po_line_id,
          quantity: l.quantity,
          assetTags: l.asset_tags ?? [],
          venueId: l.venue_id ?? null,
          conditionEnumId: l.condition_enum_id ?? null,
        })),
      }),
    );
    return ok({
      outcome: result.outcome,
      goods_receipt_id: result.goodsReceiptId,
      receipt_line_ids: [...result.receiptLineIds],
      asset_unit_ids: [...result.assetUnitIds],
      lot_movement_ids: [...result.lotMovementIds],
    });
  },

  "purchaseOrders.returnGoods": async ({ params, body }, context) => {
    await purchaseOrders.read(context, params.id, ["id"]);
    const result = unwrap(
      await recordGoodsReturn(context.db, {
        eventId: crypto.randomUUID(),
        purchaseOrderId: params.id,
        reason: body.reason as GoodsReturnReason,
        note: body.note ?? null,
        lines: body.lines.map((l) => ({
          receiptLineId: l.receipt_line_id,
          quantity: l.quantity,
          assetUnitIds: l.asset_unit_ids ?? [],
          venueId: l.venue_id ?? null,
        })),
      }),
    );
    return ok({
      outcome: result.outcome,
      goods_return_id: result.goodsReturnId,
      return_line_ids: [...result.returnLineIds],
    });
  },

  "poLines.hireWindowWarnings": async ({ query }, context) => {
    requireOrg(context);
    const warnings = unwrap(
      await getHireWindowWarnings(context.db, {
        projectId: query.project_id,
        hireFrom: query.from,
        hireTo: query.to,
      }),
    );
    return ok({ data: warnings });
  },

  // Field history (A106, migration 1452).
  "purchaseOrders.fieldHistory": async ({ params, query }, context) =>
    ok((await fieldHistory(context, "app.purchase_orders", params.id, query.limit)) as never),
});
