import type { Database, XosClient } from "./client.ts";
import {
  blankToNull,
  deletedNow,
  insertedId,
  readOne,
  readRows,
  rpcValue,
  touched,
  type Transition,
} from "./commercial-common.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import * as enums from "./enums.generated.ts";

/**
 * Procurement repository (Section 4.2 Procurement, Section 7.4, invariants 10 and 17): RFQs with
 * invitations and sealed responses, purchase orders with lines and change orders, goods receipts,
 * three-way invoice matches, catalog bindings and vendor products (migration 0331). Approval runs
 * spend authority and separation of duties inside A03's RPCs; this module only calls them.
 */

type Tables = Database["app"]["Tables"];
export type RfqState = Database["app"]["Enums"]["rfq_state"];
export type PoState = Database["app"]["Enums"]["po_state"];
export type PoChangeOrderState = Database["app"]["Enums"]["po_change_order_state"];
export type ApprovalDecision = Database["app"]["Enums"]["approval_decision"];

export const RFQ_STATES: readonly RfqState[] = enums.rfqState;
export const PO_STATES: readonly PoState[] = enums.poState;

/** A project as procurement pickers and display keys need it. */
export interface ProjectOption {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/** Projects the viewer can read, by key (row level security limits them to the viewer's projects). */
export async function listProjectOptions(
  db: XosClient,
  orgId: string,
): Promise<Result<ProjectOption[]>> {
  return readRows(
    db
      .from("projects")
      .select("id, project_key, name")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .is("archived_at", null)
      .order("project_key"),
    (row) => ({ id: row.id, key: row.project_key, name: row.name }),
  );
}

/** Currencies the platform knows (app.currencies), by code. */
export async function listCurrencies(
  db: XosClient,
): Promise<Result<{ code: string; minorUnits: number }[]>> {
  return readRows(
    db.from("currencies").select("currency_code, minor_unit_exponent").order("currency_code"),
    (row) => ({ code: row.currency_code ?? "", minorUnits: row.minor_unit_exponent ?? 2 }),
  );
}

/** `{projectKey}-{prefix}{number}`, for example NWL-PO7; the number comes from the database. */
export function displayKey(projectKey: string | null, prefix: string, number: number): string {
  return `${projectKey ?? "?"}-${prefix}${number}`;
}

interface ProjectEmbed {
  project: { project_key: string; name: string } | null;
}

interface VendorEmbed {
  vendor: { counterparty: { counterparty_name: string | null } | null } | null;
}

const projectKeyOf = (row: ProjectEmbed) => row.project?.project_key ?? null;
const vendorNameOf = (row: VendorEmbed) => row.vendor?.counterparty?.counterparty_name ?? null;

// RFQs ----------------------------------------------------------------------------------------------

export interface Rfq {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string | null;
  readonly number: number;
  readonly key: string;
  readonly title: string;
  readonly responsesDueAt: string | null;
  readonly state: RfqState;
  readonly invitedVendorIds: readonly string[];
  readonly createdAt: string;
}

const RFQ_COLUMNS =
  "id, project_id, rfq_number, title, responses_due_at, rfq_state, created_at, project:projects(project_key, name), rfq_invitations(vendor_id, deleted_at)" as const;

interface RfqRow extends ProjectEmbed {
  id: string;
  project_id: string;
  rfq_number: number;
  title: string;
  responses_due_at: string | null;
  rfq_state: RfqState;
  created_at: string;
  rfq_invitations: { vendor_id: string; deleted_at: string | null }[] | null;
}

function toRfq(row: RfqRow): Rfq {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: projectKeyOf(row),
    number: row.rfq_number,
    key: displayKey(projectKeyOf(row), "RFQ", row.rfq_number),
    title: row.title,
    responsesDueAt: row.responses_due_at,
    state: row.rfq_state,
    invitedVendorIds: (row.rfq_invitations ?? [])
      .filter((i) => i.deleted_at === null)
      .map((i) => i.vendor_id),
    createdAt: row.created_at,
  };
}

export async function listRfqs(db: XosClient, orgId: string): Promise<Result<Rfq[]>> {
  return readRows(
    db
      .from("rfqs")
      .select(RFQ_COLUMNS)
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    (row) => toRfq(row),
  );
}

export async function getRfq(db: XosClient, id: string): Promise<Result<Rfq>> {
  return readOne(
    db.from("rfqs").select(RFQ_COLUMNS).eq("id", id).is("deleted_at", null).maybeSingle(),
    (row) => toRfq(row),
  );
}

export interface RfqInput {
  readonly title: string;
  readonly responsesDueAt: string | null;
}

export async function createRfq(
  db: XosClient,
  input: RfqInput & { readonly projectId: string },
): Promise<Result<{ id: string }>> {
  const row = {
    project_id: input.projectId,
    title: input.title.trim(),
    responses_due_at: blankToNull(input.responsesDueAt),
  } as Tables["rfqs"]["Insert"];
  return insertedId(db.from("rfqs").insert(row).select("id").single());
}

export async function updateRfq(db: XosClient, id: string, input: RfqInput): Promise<Result<null>> {
  return touched(
    db
      .from("rfqs")
      .update({ title: input.title.trim(), responses_due_at: blankToNull(input.responsesDueAt) })
      .eq("id", id)
      .select("id"),
  );
}

/** Issues, closes (unsealing responses), awards or cancels an RFQ (app.transition_rfq). */
export async function transitionRfq(
  db: XosClient,
  move: Transition<RfqState>,
): Promise<Result<null>> {
  const result = await rpcValue(
    db.rpc("transition_rfq", {
      p_rfq_id: move.id,
      p_expected: move.expected,
      p_next: move.next,
      p_reason: move.reason,
    }),
  );
  return result.ok ? ok(null) : result;
}

/** Invites a vendor of the same org to respond. */
export async function inviteVendorToRfq(
  db: XosClient,
  rfqId: string,
  vendorId: string,
): Promise<Result<{ id: string }>> {
  const row = { rfq_id: rfqId, vendor_id: vendorId } as Tables["rfq_invitations"]["Insert"];
  return insertedId(db.from("rfq_invitations").insert(row).select("id").single());
}

/** Withdraws a vendor's invitation. */
export async function removeRfqInvitation(
  db: XosClient,
  rfqId: string,
  vendorId: string,
): Promise<Result<null>> {
  return touched(
    db
      .from("rfq_invitations")
      .update(deletedNow())
      .eq("rfq_id", rfqId)
      .eq("vendor_id", vendorId)
      .is("deleted_at", null)
      .select("id"),
  );
}

export interface RfqResponseLine {
  readonly id: string;
  readonly description: string;
  readonly elementId: string | null;
  readonly quantity: number;
  /** Null when the vendor did not quote the line. */
  readonly unitPriceMinor: number | null;
  readonly currencyCode: string;
}

export interface RfqResponse {
  readonly id: string;
  readonly vendorId: string;
  readonly vendorName: string | null;
  readonly submittedAt: string;
  readonly validUntil: string | null;
  readonly lines: readonly RfqResponseLine[];
  /** Sum of quoted lines; null when any line is unquoted or there are none. */
  readonly totalMinor: number | null;
}

/** Extended amount in minor units, rounded half away from zero like private.extended_minor. */
export function extendedMinor(quantity: number, unitPriceMinor: number | null): number | null {
  if (unitPriceMinor === null) return null;
  const value = quantity * unitPriceMinor;
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** NULL-aware sum: null when there are no amounts or any amount is null (unpriced). */
export function nullAwareTotal(amounts: readonly (number | null)[]): number | null {
  if (amounts.length === 0 || amounts.some((a) => a === null)) return null;
  return (amounts as number[]).reduce((a, b) => a + b, 0);
}

/**
 * Responses to an RFQ. Responses are sealed: row level security returns none until the RFQ is
 * Closed or Awarded, so an empty list on an Issued RFQ means sealed, not absent.
 */
export async function listRfqResponses(
  db: XosClient,
  rfqId: string,
): Promise<Result<RfqResponse[]>> {
  return readRows(
    db
      .from("rfq_responses")
      .select(
        "id, vendor_id, submitted_at, valid_until, vendor:vendors(counterparty:counterparties(counterparty_name)), rfq_response_lines(id, description, element_id, quantity, unit_price_minor, currency_code, deleted_at)",
      )
      .eq("rfq_id", rfqId)
      .is("deleted_at", null)
      .order("submitted_at"),
    (row) => {
      const lines = (row.rfq_response_lines ?? [])
        .filter((l) => l.deleted_at === null)
        .map((l) => ({
          id: l.id,
          description: l.description,
          elementId: l.element_id,
          quantity: l.quantity,
          unitPriceMinor: l.unit_price_minor,
          currencyCode: l.currency_code,
        }));
      return {
        id: row.id,
        vendorId: row.vendor_id,
        vendorName: vendorNameOf(row as VendorEmbed),
        submittedAt: row.submitted_at,
        validUntil: row.valid_until,
        lines,
        totalMinor: nullAwareTotal(lines.map((l) => extendedMinor(l.quantity, l.unitPriceMinor))),
      };
    },
  );
}

export interface ResponseLineInput {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly elementId?: string | null;
}

/**
 * Records a vendor's response with its lines on the vendor's behalf (for example a quote received
 * by email). The database accepts it only while the RFQ is Issued and only from an invited vendor.
 */
export async function recordRfqResponse(
  db: XosClient,
  input: {
    readonly rfqId: string;
    readonly vendorId: string;
    readonly validUntil: string | null;
    readonly currencyCode: string;
    readonly lines: readonly ResponseLineInput[];
  },
): Promise<Result<{ id: string }>> {
  if (input.lines.length === 0) return fail({ kind: "invalid", message: "lines" });
  // Responses are sealed until the RFQ closes, so the recorder cannot read the rows back: one RPC
  // (0493) records the response and its lines together.
  const id = await rpcValue(
    db.rpc("record_rfq_response", {
      p_rfq_id: input.rfqId,
      p_vendor_id: input.vendorId,
      p_valid_until: blankToNull(input.validUntil) as string,
      p_currency_code: input.currencyCode,
      p_lines: input.lines.map((l) => ({
        description: l.description.trim(),
        element_id: blankToNull(l.elementId),
        quantity: l.quantity,
        unit_price_minor: l.unitPriceMinor,
      })),
    }),
  );
  return id.ok ? ok({ id: id.data }) : id;
}

// Purchase orders --------------------------------------------------------------------------------------

export interface PurchaseOrder {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string | null;
  readonly number: number;
  readonly key: string;
  readonly vendorId: string;
  readonly vendorName: string | null;
  readonly rfqResponseId: string | null;
  readonly currencyCode: string;
  readonly state: PoState;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export interface PurchaseOrderTotals {
  readonly unpricedCount: number;
  /** Null while any line is unpriced or the order has no lines. */
  readonly linesTotalMinor: number | null;
  readonly approvedChangesMinor: number | null;
}

const PO_COLUMNS =
  "id, project_id, po_number, vendor_id, rfq_response_id, currency_code, po_state, created_at, created_by, project:projects(project_key, name), vendor:vendors(counterparty:counterparties(counterparty_name))" as const;

interface PoRow extends ProjectEmbed, VendorEmbed {
  id: string;
  project_id: string;
  po_number: number;
  vendor_id: string;
  rfq_response_id: string | null;
  currency_code: string;
  po_state: PoState;
  created_at: string;
  created_by: string | null;
}

function toPurchaseOrder(row: PoRow): PurchaseOrder {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: projectKeyOf(row),
    number: row.po_number,
    key: displayKey(projectKeyOf(row), "PO", row.po_number),
    vendorId: row.vendor_id,
    vendorName: vendorNameOf(row),
    rfqResponseId: row.rfq_response_id,
    currencyCode: row.currency_code,
    state: row.po_state,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export async function listPurchaseOrders(
  db: XosClient,
  orgId: string,
): Promise<Result<(PurchaseOrder & { totals: PurchaseOrderTotals })[]>> {
  const [orders, totals] = await Promise.all([
    readRows(
      db
        .from("purchase_orders")
        .select(PO_COLUMNS)
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
      (row) => toPurchaseOrder(row),
    ),
    readRows(
      db
        .from("purchase_order_totals")
        .select("purchase_order_id, unpriced_count, lines_total_minor, approved_changes_minor"),
      (row) => row,
    ),
  ]);
  if (!orders.ok) return orders;
  if (!totals.ok) return totals;
  const byOrder = new Map(totals.data.map((t) => [t.purchase_order_id, t]));
  return ok(
    orders.data.map((order) => {
      const t = byOrder.get(order.id);
      return {
        ...order,
        totals: {
          unpricedCount: t?.unpriced_count ?? 0,
          linesTotalMinor: t?.lines_total_minor ?? null,
          approvedChangesMinor: t?.approved_changes_minor ?? null,
        },
      };
    }),
  );
}

export async function getPurchaseOrder(db: XosClient, id: string): Promise<Result<PurchaseOrder>> {
  return readOne(
    db.from("purchase_orders").select(PO_COLUMNS).eq("id", id).is("deleted_at", null).maybeSingle(),
    (row) => toPurchaseOrder(row),
  );
}

export interface PoLine {
  readonly id: string;
  readonly lineNumber: number;
  readonly description: string;
  readonly elementId: string | null;
  readonly budgetLineId: string | null;
  readonly quantity: number;
  readonly unitBasis: string | null;
  /** Null is unpriced and blocks approval. */
  readonly unitPriceMinor: number | null;
  readonly extendedMinor: number | null;
  readonly receivedQuantity: number;
}

/** Lines of a purchase order in line order, with what has been received against each. */
export async function listPoLines(
  db: XosClient,
  purchaseOrderId: string,
): Promise<Result<PoLine[]>> {
  return readRows(
    db
      .from("po_lines")
      .select(
        "id, line_number, description, element_id, budget_line_id, quantity, unit_basis, unit_price_minor, receipt_lines(quantity_received, deleted_at)",
      )
      .eq("purchase_order_id", purchaseOrderId)
      .is("deleted_at", null)
      .order("line_number"),
    (row) => ({
      id: row.id,
      lineNumber: row.line_number,
      description: row.description,
      elementId: row.element_id,
      budgetLineId: row.budget_line_id,
      quantity: row.quantity,
      unitBasis: row.unit_basis,
      unitPriceMinor: row.unit_price_minor,
      extendedMinor: extendedMinor(row.quantity, row.unit_price_minor),
      receivedQuantity: (row.receipt_lines ?? [])
        .filter((r) => r.deleted_at === null)
        .reduce((sum, r) => sum + r.quantity_received, 0),
    }),
  );
}

export async function getPurchaseOrderTotals(
  db: XosClient,
  purchaseOrderId: string,
): Promise<Result<PurchaseOrderTotals>> {
  const { data, error } = await db
    .from("purchase_order_totals")
    .select("unpriced_count, lines_total_minor, approved_changes_minor")
    .eq("purchase_order_id", purchaseOrderId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return ok({
    unpricedCount: data?.unpriced_count ?? 0,
    linesTotalMinor: data?.lines_total_minor ?? null,
    approvedChangesMinor: data?.approved_changes_minor ?? null,
  });
}

export interface PurchaseOrderInput {
  readonly projectId: string;
  readonly vendorId: string;
  readonly currencyCode: string;
  readonly rfqResponseId?: string | null;
}

/** Creates a Proposed order; the database refuses a closed production or a blocked vendor. */
export async function createPurchaseOrder(
  db: XosClient,
  input: PurchaseOrderInput,
): Promise<Result<{ id: string }>> {
  const row = {
    project_id: input.projectId,
    vendor_id: input.vendorId,
    currency_code: input.currencyCode,
    rfq_response_id: blankToNull(input.rfqResponseId),
  } as Tables["purchase_orders"]["Insert"];
  return insertedId(db.from("purchase_orders").insert(row).select("id").single());
}

export interface PoLineInput {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly unitBasis?: string | null;
  readonly elementId?: string | null;
  readonly budgetLineId?: string | null;
}

function poLineRow(input: PoLineInput) {
  return {
    description: input.description.trim(),
    quantity: input.quantity,
    unit_price_minor: input.unitPriceMinor,
    unit_basis: blankToNull(input.unitBasis),
    element_id: blankToNull(input.elementId),
    budget_line_id: blankToNull(input.budgetLineId),
  };
}

/** Adds a line after the last one; lines change only while the order is Proposed. */
export async function addPoLine(
  db: XosClient,
  purchaseOrderId: string,
  input: PoLineInput,
): Promise<Result<{ id: string }>> {
  const last = await readRows(
    db
      .from("po_lines")
      .select("line_number")
      .eq("purchase_order_id", purchaseOrderId)
      .is("deleted_at", null)
      .order("line_number", { ascending: false })
      .limit(1),
    (row) => row.line_number,
  );
  if (!last.ok) return last;
  const row = {
    ...poLineRow(input),
    purchase_order_id: purchaseOrderId,
    line_number: (last.data[0] ?? 0) + 1,
  } as Tables["po_lines"]["Insert"];
  return insertedId(db.from("po_lines").insert(row).select("id").single());
}

export async function updatePoLine(
  db: XosClient,
  id: string,
  input: PoLineInput,
): Promise<Result<null>> {
  return touched(db.from("po_lines").update(poLineRow(input)).eq("id", id).select("id"));
}

export async function removePoLine(db: XosClient, id: string): Promise<Result<null>> {
  return touched(db.from("po_lines").update(deletedNow()).eq("id", id).select("id"));
}

/**
 * Approves a Proposed order (app.approve_purchase_order): never by its creator, fully priced,
 * within spend authority. `approved` is false while a second approver is still needed.
 */
export async function approvePurchaseOrder(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ approved: boolean }>> {
  const result = await rpcValue(
    db.rpc("approve_purchase_order", { p_purchase_order_id: id, p_reason: reason }),
  );
  return result.ok ? ok({ approved: result.data === true }) : result;
}

/** Sends, closes or cancels an order (app.transition_purchase_order). */
export async function transitionPurchaseOrder(
  db: XosClient,
  move: Transition<PoState>,
): Promise<Result<null>> {
  const result = await rpcValue(
    db.rpc("transition_purchase_order", {
      p_purchase_order_id: move.id,
      p_expected: move.expected,
      p_next: move.next,
      p_reason: move.reason,
    }),
  );
  return result.ok ? ok(null) : result;
}

/**
 * Creates a Proposed purchase order from an awarded RFQ response, copying its quoted lines.
 * Unquoted lines stay unpriced, so the order cannot be approved until they are priced.
 */
export async function createPurchaseOrderFromResponse(
  db: XosClient,
  input: { readonly projectId: string; readonly response: RfqResponse },
): Promise<Result<{ id: string }>> {
  const currency = input.response.lines[0]?.currencyCode;
  if (!currency) return fail({ kind: "invalid", message: "lines" });
  const order = await createPurchaseOrder(db, {
    projectId: input.projectId,
    vendorId: input.response.vendorId,
    currencyCode: currency,
    rfqResponseId: input.response.id,
  });
  if (!order.ok) return order;
  const lines = input.response.lines.map(
    (l, index) =>
      ({
        purchase_order_id: order.data.id,
        line_number: index + 1,
        description: l.description,
        element_id: l.elementId,
        quantity: l.quantity,
        unit_price_minor: l.unitPriceMinor,
      }) as Tables["po_lines"]["Insert"],
  );
  const inserted = await readRows(db.from("po_lines").insert(lines).select("id"), (r) => r);
  return inserted.ok ? order : inserted;
}

// PO change orders ------------------------------------------------------------------------------------

export interface PoChangeOrder {
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly description: string;
  /** Null while unpriced; never stored as zero. */
  readonly amountDeltaMinor: number | null;
  readonly state: PoChangeOrderState;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export async function listPoChangeOrders(
  db: XosClient,
  purchaseOrderId: string,
): Promise<Result<PoChangeOrder[]>> {
  return readRows(
    db
      .from("po_change_orders")
      .select(
        "id, purchase_order_id, description, amount_delta_minor, po_change_order_state, created_by, created_at",
      )
      .eq("purchase_order_id", purchaseOrderId)
      .is("deleted_at", null)
      .order("created_at"),
    (row) => ({
      id: row.id,
      purchaseOrderId: row.purchase_order_id,
      description: row.description,
      amountDeltaMinor: row.amount_delta_minor,
      state: row.po_change_order_state,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }),
  );
}

export async function createPoChangeOrder(
  db: XosClient,
  input: {
    readonly purchaseOrderId: string;
    readonly description: string;
    readonly amountDeltaMinor: number | null;
  },
): Promise<Result<{ id: string }>> {
  const row = {
    purchase_order_id: input.purchaseOrderId,
    description: input.description.trim(),
    amount_delta_minor: input.amountDeltaMinor,
  } as Tables["po_change_orders"]["Insert"];
  return insertedId(db.from("po_change_orders").insert(row).select("id").single());
}

/** Prices a Proposed change order. */
export async function pricePoChangeOrder(
  db: XosClient,
  id: string,
  amountDeltaMinor: number | null,
): Promise<Result<null>> {
  return touched(
    db
      .from("po_change_orders")
      .update({ amount_delta_minor: amountDeltaMinor })
      .eq("id", id)
      .select("id"),
  );
}

/** Approves or rejects a change order; `decided` is false while a second approver is needed. */
export async function decidePoChangeOrder(
  db: XosClient,
  input: { readonly id: string; readonly decision: ApprovalDecision; readonly reason: string },
): Promise<Result<{ decided: boolean }>> {
  const result = await rpcValue(
    db.rpc("decide_po_change_order", {
      p_po_change_order_id: input.id,
      p_decision: input.decision,
      p_reason: input.reason,
    }),
  );
  return result.ok ? ok({ decided: result.data === true }) : result;
}

// Goods receipts -----------------------------------------------------------------------------------------

export interface GoodsReceipt {
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly purchaseOrderKey: string;
  readonly projectKey: string | null;
  readonly vendorName: string | null;
  readonly receivedAt: string;
  readonly receivedBy: string | null;
  readonly receiverName: string | null;
  readonly note: string | null;
  readonly lines: readonly { poLineId: string; quantityReceived: number }[];
  readonly matched: boolean;
}

const RECEIPT_COLUMNS =
  "id, purchase_order_id, received_at, received_by, note, receiver:people!goods_receipts_received_by_fkey(full_name), purchase_order:purchase_orders!inner(po_number, project:projects(project_key, name), vendor:vendors(counterparty:counterparties(counterparty_name))), receipt_lines(po_line_id, quantity_received, deleted_at), invoice_matches(id, deleted_at)" as const;

interface ReceiptRow {
  id: string;
  purchase_order_id: string;
  received_at: string;
  received_by: string | null;
  note: string | null;
  receiver: { full_name: string | null } | null;
  purchase_order: (ProjectEmbed & VendorEmbed & { po_number: number }) | null;
  receipt_lines:
    { po_line_id: string; quantity_received: number; deleted_at: string | null }[] | null;
  invoice_matches: { id: string; deleted_at: string | null }[] | null;
}

function toReceipt(row: ReceiptRow): GoodsReceipt {
  const order = row.purchase_order;
  const projectKey = order ? projectKeyOf(order) : null;
  return {
    id: row.id,
    purchaseOrderId: row.purchase_order_id,
    purchaseOrderKey: displayKey(projectKey, "PO", order?.po_number ?? 0),
    projectKey,
    vendorName: order ? vendorNameOf(order) : null,
    receivedAt: row.received_at,
    receivedBy: row.received_by,
    receiverName: row.receiver?.full_name ?? null,
    note: row.note,
    lines: (row.receipt_lines ?? [])
      .filter((l) => l.deleted_at === null)
      .map((l) => ({ poLineId: l.po_line_id, quantityReceived: l.quantity_received })),
    matched: (row.invoice_matches ?? []).some((m) => m.deleted_at === null),
  };
}

export async function listGoodsReceipts(
  db: XosClient,
  orgId: string,
  purchaseOrderId?: string,
): Promise<Result<GoodsReceipt[]>> {
  let query = db
    .from("goods_receipts")
    .select(RECEIPT_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (purchaseOrderId) query = query.eq("purchase_order_id", purchaseOrderId);
  return readRows(query.order("received_at", { ascending: false }), (row) => toReceipt(row));
}

export async function getGoodsReceipt(db: XosClient, id: string): Promise<Result<GoodsReceipt>> {
  return readOne(
    db
      .from("goods_receipts")
      .select(RECEIPT_COLUMNS)
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle(),
    (row) => toReceipt(row),
  );
}

/**
 * Records goods received against an approved or sent order. Lines with no quantity are skipped;
 * the database refuses receipts beyond the quantity ordered.
 */
export async function recordGoodsReceipt(
  db: XosClient,
  input: {
    readonly purchaseOrderId: string;
    readonly note: string | null;
    readonly lines: readonly { readonly poLineId: string; readonly quantity: number }[];
  },
): Promise<Result<{ id: string }>> {
  const lines = input.lines.filter((l) => l.quantity > 0);
  if (lines.length === 0) return fail({ kind: "invalid", message: "lines" });
  const receipt = await insertedId(
    db
      .from("goods_receipts")
      .insert({
        purchase_order_id: input.purchaseOrderId,
        note: blankToNull(input.note),
      } as Tables["goods_receipts"]["Insert"])
      .select("id")
      .single(),
  );
  if (!receipt.ok) return receipt;
  const rows = lines.map(
    (l) =>
      ({
        goods_receipt_id: receipt.data.id,
        po_line_id: l.poLineId,
        quantity_received: l.quantity,
      }) as Tables["receipt_lines"]["Insert"],
  );
  const inserted = await readRows(db.from("receipt_lines").insert(rows).select("id"), (r) => r);
  if (!inserted.ok) {
    // The receipt header is withdrawn so a refused receipt leaves nothing half recorded.
    await db.from("goods_receipts").update(deletedNow()).eq("id", receipt.data.id);
    return inserted;
  }
  return receipt;
}

// Three-way match (invariant 17) --------------------------------------------------------------------------

export interface InvoiceMatch {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string | null;
  readonly invoiceState: string | null;
  readonly purchaseOrderId: string;
  readonly purchaseOrderKey: string;
  readonly goodsReceiptId: string;
  readonly vendorName: string | null;
  readonly currencyCode: string | null;
  /** Invoice total minus value received at order prices; null when either side is unpriced. */
  readonly varianceMinor: number | null;
  readonly isMatched: boolean;
  readonly isResolved: boolean;
  readonly resolutionNote: string | null;
  readonly resolvedBy: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export type MatchStanding = "matched" | "resolved" | "mismatch";

export function matchStanding(
  match: Pick<InvoiceMatch, "isMatched" | "isResolved">,
): MatchStanding {
  if (match.isMatched) return "matched";
  return match.isResolved ? "resolved" : "mismatch";
}

const MATCH_COLUMNS =
  "id, invoice_id, purchase_order_id, goods_receipt_id, resolution_note, resolved_by, created_by, created_at, invoice:invoices(invoice_number, invoice_state, currency_code), purchase_order:purchase_orders(po_number, project:projects(project_key, name), vendor:vendors(counterparty:counterparties(counterparty_name)))" as const;

export async function listInvoiceMatches(
  db: XosClient,
  orgId: string,
): Promise<Result<InvoiceMatch[]>> {
  const [matches, results] = await Promise.all([
    readRows(
      db
        .from("invoice_matches")
        .select(MATCH_COLUMNS)
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
      (row) => row,
    ),
    readRows(
      db
        .from("invoice_match_results")
        .select("invoice_match_id, variance_minor, is_matched, is_resolved"),
      (row) => row,
    ),
  ]);
  if (!matches.ok) return matches;
  if (!results.ok) return results;
  const byMatch = new Map(results.data.map((r) => [r.invoice_match_id, r]));
  return ok(
    matches.data.map((m) => {
      const r = byMatch.get(m.id);
      const order = m.purchase_order;
      return {
        id: m.id,
        invoiceId: m.invoice_id,
        invoiceNumber: m.invoice?.invoice_number ?? null,
        invoiceState: m.invoice?.invoice_state ?? null,
        purchaseOrderId: m.purchase_order_id,
        purchaseOrderKey: displayKey(
          order ? projectKeyOf(order) : null,
          "PO",
          order?.po_number ?? 0,
        ),
        goodsReceiptId: m.goods_receipt_id,
        vendorName: order ? vendorNameOf(order) : null,
        currencyCode: m.invoice?.currency_code ?? null,
        varianceMinor: r?.variance_minor ?? null,
        isMatched: r?.is_matched ?? false,
        isResolved: r?.is_resolved ?? false,
        resolutionNote: m.resolution_note,
        resolvedBy: m.resolved_by,
        createdBy: m.created_by,
        createdAt: m.created_at,
      };
    }),
  );
}

/** Payable invoices of the org that can be matched, with their vendor. */
export async function listPayableInvoices(
  db: XosClient,
  orgId: string,
): Promise<
  Result<
    { id: string; label: string; projectId: string; counterpartyId: string | null; state: string }[]
  >
> {
  return readRows(
    db
      .from("invoices")
      .select(
        "id, invoice_number, project_id, counterparty_id, invoice_state, counterparty:counterparties(counterparty_name)",
      )
      .eq("org_id", orgId)
      .eq("direction", "Payable")
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    (row) => ({
      id: row.id,
      label: [row.invoice_number, row.counterparty?.counterparty_name].filter(Boolean).join(" · "),
      projectId: row.project_id,
      counterpartyId: row.counterparty_id,
      state: row.invoice_state,
    }),
  );
}

/** Matches an invoice to an order and one of its receipts; a receipt is matched once. */
export async function createInvoiceMatch(
  db: XosClient,
  input: {
    readonly invoiceId: string;
    readonly purchaseOrderId: string;
    readonly goodsReceiptId: string;
  },
): Promise<Result<{ id: string }>> {
  const row = {
    invoice_id: input.invoiceId,
    purchase_order_id: input.purchaseOrderId,
    goods_receipt_id: input.goodsReceiptId,
  } as Tables["invoice_matches"]["Insert"];
  return insertedId(db.from("invoice_matches").insert(row).select("id").single());
}

/** Accepts a mismatch with a resolution; only someone other than the matcher, once. */
export async function resolveInvoiceMatch(
  db: XosClient,
  id: string,
  note: string,
): Promise<Result<null>> {
  return touched(
    db.from("invoice_matches").update({ resolution_note: note.trim() }).eq("id", id).select("id"),
  );
}

/** Approves the payable invoice (app.approve_invoice); refused while a mismatch is unresolved. */
export async function approveMatchedInvoice(
  db: XosClient,
  invoiceId: string,
  reason: string,
): Promise<Result<{ approved: boolean }>> {
  const result = await rpcValue(
    db.rpc("approve_invoice", { p_invoice_id: invoiceId, p_reason: reason }),
  );
  return result.ok ? ok({ approved: result.data === true }) : result;
}

// Catalog bindings and vendor products -----------------------------------------------------------------------

export interface CatalogBinding {
  readonly id: string;
  /** {URID}-{ORG}-{SEQ}, issued by the database. */
  readonly itemId: string;
  readonly elementId: string;
  readonly elementName: string | null;
  readonly urid: string | null;
  readonly name: string;
  readonly unitBasis: string | null;
  readonly defaultUnitPriceMinor: number | null;
  readonly currencyCode: string | null;
}

export async function listCatalogBindings(
  db: XosClient,
  orgId: string,
): Promise<Result<CatalogBinding[]>> {
  const bindings = await readRows(
    db
      .from("catalog_bindings")
      .select("id, item_id, element_id, name, unit_basis, default_unit_price_minor, currency_code")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("item_id"),
    (row) => row,
  );
  if (!bindings.ok) return bindings;
  const ids = [...new Set(bindings.data.map((b) => b.element_id))];
  const elements = ids.length
    ? await readRows(
        db.schema("xpms").from("elements").select("element_id, item, urid").in("element_id", ids),
        (row) => row,
      )
    : ok([]);
  if (!elements.ok) return elements;
  const byId = new Map(elements.data.map((e) => [e.element_id, e]));
  return ok(
    bindings.data.map((b) => ({
      id: b.id,
      itemId: b.item_id,
      elementId: b.element_id,
      elementName: byId.get(b.element_id)?.item ?? null,
      urid: byId.get(b.element_id)?.urid ?? null,
      name: b.name,
      unitBasis: b.unit_basis,
      defaultUnitPriceMinor: b.default_unit_price_minor,
      currencyCode: b.currency_code,
    })),
  );
}

export interface CatalogBindingInput {
  readonly name: string;
  readonly unitBasis: string | null;
  readonly defaultUnitPriceMinor: number | null;
  readonly currencyCode: string | null;
}

function bindingRow(input: CatalogBindingInput) {
  return {
    name: input.name.trim(),
    unit_basis: blankToNull(input.unitBasis),
    default_unit_price_minor: input.defaultUnitPriceMinor,
    currency_code: blankToNull(input.currencyCode),
  };
}

/** Binds a canon element into the org catalog; the database issues the item ID. */
export async function createCatalogBinding(
  db: XosClient,
  orgId: string,
  input: CatalogBindingInput & { readonly elementId: string },
): Promise<Result<{ id: string }>> {
  return insertedId(
    db
      .from("catalog_bindings")
      .insert({ ...bindingRow(input), org_id: orgId, element_id: input.elementId })
      .select("id")
      .single(),
  );
}

export async function updateCatalogBinding(
  db: XosClient,
  id: string,
  input: CatalogBindingInput,
): Promise<Result<null>> {
  return touched(db.from("catalog_bindings").update(bindingRow(input)).eq("id", id).select("id"));
}

export async function deleteCatalogBinding(db: XosClient, id: string): Promise<Result<null>> {
  return touched(db.from("catalog_bindings").update(deletedNow()).eq("id", id).select("id"));
}

export interface VendorProduct {
  readonly id: string;
  readonly vendorId: string;
  readonly vendorName: string | null;
  readonly catalogBindingId: string | null;
  readonly elementId: string | null;
  readonly vendorSku: string;
  readonly unitPriceMinor: number | null;
  readonly currencyCode: string | null;
  readonly leadTimeDays: number | null;
}

export async function listVendorProducts(
  db: XosClient,
  filter: { readonly catalogBindingId?: string; readonly vendorId?: string },
): Promise<Result<VendorProduct[]>> {
  let query = db
    .from("vendor_products")
    .select(
      "id, vendor_id, catalog_binding_id, element_id, vendor_sku, unit_price_minor, currency_code, lead_time_days, vendor:vendors(counterparty:counterparties(counterparty_name))",
    )
    .is("deleted_at", null);
  if (filter.catalogBindingId) query = query.eq("catalog_binding_id", filter.catalogBindingId);
  if (filter.vendorId) query = query.eq("vendor_id", filter.vendorId);
  return readRows(query.order("vendor_sku"), (row) => ({
    id: row.id,
    vendorId: row.vendor_id,
    vendorName: vendorNameOf(row as VendorEmbed),
    catalogBindingId: row.catalog_binding_id,
    elementId: row.element_id,
    vendorSku: row.vendor_sku,
    unitPriceMinor: row.unit_price_minor,
    currencyCode: row.currency_code,
    leadTimeDays: row.lead_time_days,
  }));
}

export async function createVendorProduct(
  db: XosClient,
  input: {
    readonly vendorId: string;
    readonly catalogBindingId: string | null;
    readonly vendorSku: string;
    readonly unitPriceMinor: number | null;
    readonly currencyCode: string | null;
    readonly leadTimeDays: number | null;
  },
): Promise<Result<{ id: string }>> {
  const row = {
    vendor_id: input.vendorId,
    catalog_binding_id: blankToNull(input.catalogBindingId),
    vendor_sku: input.vendorSku.trim(),
    unit_price_minor: input.unitPriceMinor,
    currency_code: blankToNull(input.currencyCode),
    lead_time_days: input.leadTimeDays,
  } as Tables["vendor_products"]["Insert"];
  return insertedId(db.from("vendor_products").insert(row).select("id").single());
}

export async function deleteVendorProduct(db: XosClient, id: string): Promise<Result<null>> {
  return touched(db.from("vendor_products").update(deletedNow()).eq("id", id).select("id"));
}

// Purchase order acknowledgment (A28b 0766) ------------------------------------------------------------------

/** When the vendor acknowledged a sent order in Gateway, and who; null when not yet. */
export async function getPoAcknowledgment(
  db: XosClient,
  purchaseOrderId: string,
): Promise<Result<{ acknowledgedAt: string; acknowledgedBy: string | null } | null>> {
  const { data, error } = await db
    .from("po_acknowledgments")
    .select("acknowledged_at, acknowledged_by")
    .eq("purchase_order_id", purchaseOrderId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return ok(
    data ? { acknowledgedAt: data.acknowledged_at, acknowledgedBy: data.acknowledged_by } : null,
  );
}

// Submittals (migration 0492) ------------------------------------------------------------------------------------

export type SubmittalKind = Database["app"]["Enums"]["submittal_kind"];
export type ReviewState = Database["app"]["Enums"]["review_state"];

export const SUBMITTAL_KINDS: readonly SubmittalKind[] = enums.submittalKind;
export const REVIEW_STATES: readonly ReviewState[] = enums.reviewState;

export interface Submittal {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string | null;
  readonly number: number;
  readonly key: string;
  readonly vendorId: string;
  readonly vendorName: string | null;
  readonly purchaseOrderId: string | null;
  readonly kind: SubmittalKind;
  readonly title: string;
  readonly specReference: string | null;
  readonly dueOn: string | null;
  readonly revision: number;
  readonly state: ReviewState;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly createdBy: string | null;
}

const SUBMITTAL_COLUMNS =
  "id, project_id, submittal_number, vendor_id, purchase_order_id, submittal_kind, title, spec_reference, due_on, revision, submittal_state, decided_by, decided_at, created_by, project:projects(project_key, name), vendor:vendors(counterparty:counterparties(counterparty_name))" as const;

export async function listSubmittals(
  db: XosClient,
  orgId: string,
  filter: { readonly purchaseOrderId?: string } = {},
): Promise<Result<Submittal[]>> {
  let query = db
    .from("submittals")
    .select(SUBMITTAL_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (filter.purchaseOrderId) query = query.eq("purchase_order_id", filter.purchaseOrderId);
  return readRows(query.order("created_at", { ascending: false }), (row) => ({
    id: row.id,
    projectId: row.project_id,
    projectKey: projectKeyOf(row),
    number: row.submittal_number,
    key: displayKey(projectKeyOf(row), "SUB", row.submittal_number),
    vendorId: row.vendor_id,
    vendorName: vendorNameOf(row),
    purchaseOrderId: row.purchase_order_id,
    kind: row.submittal_kind,
    title: row.title,
    specReference: row.spec_reference,
    dueOn: row.due_on,
    revision: row.revision,
    state: row.submittal_state,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdBy: row.created_by,
  }));
}

export interface SubmittalInput {
  readonly kind: SubmittalKind;
  readonly title: string;
  readonly specReference: string | null;
  readonly dueOn: string | null;
  readonly purchaseOrderId: string | null;
}

function submittalRow(input: SubmittalInput) {
  return {
    submittal_kind: input.kind,
    title: input.title.trim(),
    spec_reference: blankToNull(input.specReference),
    due_on: blankToNull(input.dueOn),
    purchase_order_id: blankToNull(input.purchaseOrderId),
  };
}

export async function createSubmittal(
  db: XosClient,
  input: SubmittalInput & { readonly projectId: string; readonly vendorId: string },
): Promise<Result<{ id: string }>> {
  const row = {
    ...submittalRow(input),
    project_id: input.projectId,
    vendor_id: input.vendorId,
  } as Tables["submittals"]["Insert"];
  return insertedId(db.from("submittals").insert(row).select("id").single());
}

export async function updateSubmittal(
  db: XosClient,
  id: string,
  input: SubmittalInput,
): Promise<Result<null>> {
  return touched(db.from("submittals").update(submittalRow(input)).eq("id", id).select("id"));
}

/** Submits, approves, returns or cancels a submittal (app.transition_submittal). */
export async function transitionSubmittal(
  db: XosClient,
  move: Transition<ReviewState>,
): Promise<Result<null>> {
  const result = await rpcValue(
    db.rpc("transition_submittal", {
      p_submittal_id: move.id,
      p_expected: move.expected,
      p_next: move.next,
      p_reason: move.reason,
    }),
  );
  return result.ok ? ok(null) : result;
}
