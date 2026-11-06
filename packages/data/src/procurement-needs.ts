import type { Database, XosClient } from "./client.ts";
import type { Json } from "./database.types.ts";
import {
  blankToNull,
  deletedNow,
  insertedId,
  readRows,
  rpcValue,
  touched,
} from "./commercial-common.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { parseHirePeriod, type AcquisitionKind } from "./procurement.ts";

/**
 * Procurement needs, sub-hire drafts and quote chasing (B11, RRR-235, migrations 3001, 3002, 3003 and 3008). A request is
 * what one party asked for and a need is what the event will get: linking never changes a need's quantity, and its
 * status is computed from order lines and cannot be set (ADR 0104 amendment). A shortage is computed against own stock
 * and drafts an RFQ whose lines become R7a rental order lines. While an RFQ is Issued, nothing here says who answered.
 */

type Tables = Database["app"]["Tables"];

/** The computed statuses of app.procurement_need_status. */
export const NEED_STATUSES = ["Needs Ordered", "Short", "On Order", "Excess"] as const;
export type NeedStatus = (typeof NEED_STATUSES)[number];

const toNeedStatus = (value: string | null | undefined): NeedStatus =>
  (NEED_STATUSES as readonly string[]).includes(value ?? "")
    ? (value as NeedStatus)
    : "Needs Ordered";

export interface ProcurementNeed {
  readonly id: string;
  readonly key: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly timeZone: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitBasis: string | null;
  readonly assetClassId: string | null;
  readonly elementId: string | null;
  readonly note: string | null;
  readonly requestedQuantity: number;
  readonly neededFrom: string | null;
  readonly neededTo: string | null;
  readonly draftedQuantity: number;
  readonly orderedQuantity: number;
  readonly receivedQuantity: number;
  readonly status: NeedStatus;
}

type NeedStatusRow = Database["app"]["Views"]["procurement_need_status"]["Row"];

function toNeed(row: NeedStatusRow): ProcurementNeed {
  const period = parseHirePeriod(row.effective_during as string | null);
  return {
    id: row.need_id ?? "",
    key: `${row.project_key ?? ""}-NEED-${row.need_number ?? 0}`,
    projectId: row.project_id ?? "",
    projectKey: row.project_key ?? "",
    timeZone: row.time_zone ?? "UTC",
    description: row.description ?? "",
    quantity: row.quantity ?? 0,
    unitBasis: row.unit_basis,
    assetClassId: row.asset_class_id,
    elementId: row.element_id,
    note: row.note,
    requestedQuantity: row.requested_quantity ?? 0,
    neededFrom: period.startsAt,
    neededTo: period.endsAt,
    draftedQuantity: row.drafted_quantity ?? 0,
    orderedQuantity: row.ordered_quantity ?? 0,
    receivedQuantity: row.received_quantity ?? 0,
    status: toNeedStatus(row.need_status),
  };
}

/** Live needs of an org, or of one project, newest first. */
export async function listProcurementNeeds(
  db: XosClient,
  orgId: string,
  projectId?: string,
): Promise<Result<ProcurementNeed[]>> {
  let query = db.from("procurement_need_status").select("*").eq("org_id", orgId);
  if (projectId) query = query.eq("project_id", projectId);
  return readRows(query.order("created_at", { ascending: false }), toNeed);
}

export interface NeedInput {
  readonly description: string;
  readonly quantity: number;
  readonly unitBasis: string | null;
  readonly assetClassId: string | null;
  readonly neededFrom: string | null;
  readonly neededTo: string | null;
  readonly note: string | null;
}

const neededDuring = (from: string | null, to: string | null): string | null =>
  from && to ? `[${from},${to})` : null;

function needRow(input: NeedInput) {
  return {
    description: input.description.trim(),
    quantity: input.quantity,
    unit_basis: blankToNull(input.unitBasis),
    asset_class_id: blankToNull(input.assetClassId),
    needed_during: neededDuring(input.neededFrom, input.neededTo),
    note: blankToNull(input.note),
  };
}

export async function createProcurementNeed(
  db: XosClient,
  projectId: string,
  input: NeedInput,
): Promise<Result<{ id: string }>> {
  return insertedId(
    db
      .from("procurement_needs")
      .insert({ project_id: projectId, ...needRow(input) } as Tables["procurement_needs"]["Insert"])
      .select("id")
      .single(),
  );
}

export async function updateProcurementNeed(
  db: XosClient,
  id: string,
  input: NeedInput,
): Promise<Result<null>> {
  return touched(db.from("procurement_needs").update(needRow(input)).eq("id", id).select("id"));
}

/** Names the catalog element a person confirmed for a free-text need. */
export async function setProcurementNeedElement(
  db: XosClient,
  id: string,
  elementId: string,
): Promise<Result<null>> {
  return touched(
    db.from("procurement_needs").update({ element_id: elementId }).eq("id", id).select("id"),
  );
}

/** Soft deletes a need; one with live requests or live order lines refuses need_has_links. */
export async function deleteProcurementNeed(db: XosClient, id: string): Promise<Result<null>> {
  return touched(db.from("procurement_needs").update(deletedNow()).eq("id", id).select("id"));
}

/** What a need's peek lists: the order lines serving it and the RFQ lines sourcing it. */
export interface NeedLinks {
  readonly requests: readonly { readonly allocationId: string }[];
  readonly orderLines: readonly {
    readonly id: string;
    readonly purchaseOrderId: string;
    readonly lineNumber: number;
    readonly description: string;
    readonly quantity: number;
    readonly orderState: string;
  }[];
  readonly rfqLines: readonly {
    readonly id: string;
    readonly rfqId: string;
    readonly title: string;
    readonly state: string;
    readonly quantity: number;
  }[];
}

export async function getNeedLinks(db: XosClient, needId: string): Promise<Result<NeedLinks>> {
  const [requests, lines, rfqLines] = await Promise.all([
    db
      .from("procurement_need_requests")
      .select("advance_allocation_id")
      .eq("procurement_need_id", needId)
      .is("deleted_at", null),
    db
      .from("po_lines")
      .select(
        "id, purchase_order_id, line_number, description, quantity, purchase_order:purchase_orders(po_state)",
      )
      .eq("procurement_need_id", needId)
      .is("deleted_at", null)
      .order("created_at"),
    db
      .from("rfq_lines")
      .select("id, rfq_id, quantity, rfq:rfqs(title, rfq_state)")
      .eq("procurement_need_id", needId)
      .is("deleted_at", null)
      .order("created_at"),
  ]);
  const error = requests.error ?? lines.error ?? rfqLines.error;
  if (error) return fail(toDataError(error));
  return ok({
    requests: (requests.data ?? []).map((r) => ({ allocationId: r.advance_allocation_id })),
    orderLines: (lines.data ?? []).map((l) => {
      const order = l.purchase_order as unknown as { po_state: string } | null;
      return {
        id: l.id,
        purchaseOrderId: l.purchase_order_id,
        lineNumber: l.line_number,
        description: l.description,
        quantity: l.quantity,
        orderState: order?.po_state ?? "",
      };
    }),
    rfqLines: (rfqLines.data ?? []).map((l) => {
      const rfq = l.rfq as unknown as { title: string; rfq_state: string } | null;
      return {
        id: l.id,
        rfqId: l.rfq_id,
        title: rfq?.title ?? "",
        state: rfq?.rfq_state ?? "",
        quantity: l.quantity,
      };
    }),
  });
}

// Consolidating ------------------------------------------------------------------------------------------------------

export interface ReadyAllocation {
  readonly id: string;
  readonly projectId: string;
  readonly assetClassId: string;
  readonly className: string;
  readonly quantity: number;
  readonly neededFrom: string | null;
  readonly neededTo: string | null;
  readonly state: string;
  readonly holderName: string | null;
  readonly partyName: string | null;
}

/** Equipment requests no need holds yet, for holders of both advancing.packet.read and procurement.po.read. */
export async function listAllocationsReadyToConsolidate(
  db: XosClient,
  orgId: string,
  projectId?: string,
): Promise<Result<ReadyAllocation[]>> {
  let query = db.from("allocations_ready_to_consolidate").select("*").eq("org_id", orgId);
  if (projectId) query = query.eq("project_id", projectId);
  return readRows(query.order("class_name").order("allocation_id"), (row) => {
    const period = parseHirePeriod(row.needed_during as string | null);
    return {
      id: row.allocation_id ?? "",
      projectId: row.project_id ?? "",
      assetClassId: row.asset_class_id ?? "",
      className: row.class_name ?? "",
      quantity: row.quantity ?? 0,
      neededFrom: period.startsAt,
      neededTo: period.endsAt,
      state: row.allocation_state ?? "",
      holderName: row.holder_name,
      partyName: row.party_name,
    };
  });
}

/** Consolidates requests: onto the need when one is named (its quantity stays), else onto one new need per class. */
export async function consolidateAllocations(
  db: XosClient,
  allocationIds: readonly string[],
  needId: string | null,
): Promise<Result<string[]>> {
  const result = await rpcValue(
    db.rpc("consolidate_allocations", {
      p_allocation_ids: [...allocationIds],
      ...(needId ? { p_need_id: needId } : {}),
    }),
  );
  return result.ok ? ok(result.data as string[]) : result;
}

export async function unlinkNeedRequest(
  db: XosClient,
  allocationId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("unlink_need_request", { p_allocation_id: allocationId });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Links an order line to a need, or clears it with null; works on an order in any state but Canceled. */
export async function setPoLineNeed(
  db: XosClient,
  poLineId: string,
  needId: string | null,
): Promise<Result<null>> {
  const { error } = await db.rpc("set_po_line_need", {
    p_po_line_id: poLineId,
    p_need_id: needId as string,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

// Quick add -----------------------------------------------------------------------------------------------------------

export interface QuickAddLine {
  readonly description: string;
  readonly quantity: number;
  readonly unitBasis?: string | null;
  readonly assetClassId?: string | null;
  readonly elementId?: string | null;
}

/** Adds lines as needs in one transaction: one bad line writes none. */
export async function addProcurementNeeds(
  db: XosClient,
  projectId: string,
  lines: readonly QuickAddLine[],
): Promise<Result<string[]>> {
  const result = await rpcValue(
    db.rpc("add_procurement_needs", {
      p_project_id: projectId,
      p_lines: lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit_basis: l.unitBasis ?? null,
        asset_class_id: l.assetClassId ?? null,
        element_id: l.assetClassId ? null : (l.elementId ?? null),
      })) as unknown as Json,
    }),
  );
  return result.ok ? ok(result.data as string[]) : result;
}

/** Adds lines to a Proposed order in one transaction, numbered after its last line. */
export async function addPoLines(
  db: XosClient,
  purchaseOrderId: string,
  lines: readonly QuickAddLine[],
): Promise<Result<string[]>> {
  const result = await rpcValue(
    db.rpc("add_po_lines", {
      p_purchase_order_id: purchaseOrderId,
      p_lines: lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit_basis: l.unitBasis ?? null,
        element_id: l.elementId ?? null,
      })) as unknown as Json,
    }),
  );
  return result.ok ? ok(result.data as string[]) : result;
}

// Shortages and sub-hire ---------------------------------------------------------------------------------------------

export interface AssetShortage {
  readonly projectId: string;
  readonly projectKey: string;
  readonly assetClassId: string;
  readonly className: string;
  readonly elementId: string;
  readonly unitBasis: string | null;
  readonly shortQuantity: number;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly openNeedId: string | null;
  readonly openRfqId: string | null;
}

export async function listAssetShortages(
  db: XosClient,
  orgId: string,
  projectId?: string,
): Promise<Result<AssetShortage[]>> {
  const { data, error } = await db.rpc("asset_shortages", {
    p_org_id: orgId,
    ...(projectId ? { p_project_id: projectId } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      projectId: r.project_id,
      projectKey: r.project_key,
      assetClassId: r.asset_class_id,
      className: r.class_name,
      elementId: r.element_id,
      unitBasis: r.unit_basis,
      shortQuantity: r.short_quantity,
      windowFrom: r.window_from,
      windowTo: r.window_to,
      openNeedId: r.open_need_id,
      openRfqId: r.open_rfq_id,
    })),
  );
}

/** Drafts a sub-hire RFQ for short classes. The event id is the RFQ id, so a replay returns it and writes nothing. */
export async function createSubHireRfq(
  db: XosClient,
  input: {
    readonly eventId: string;
    readonly projectId: string;
    readonly assetClassIds: readonly string[];
    readonly title: string;
  },
): Promise<Result<{ id: string }>> {
  const result = await rpcValue(
    db.rpc("create_sub_hire_rfq", {
      p_event_id: input.eventId,
      p_project_id: input.projectId,
      p_asset_class_ids: [...input.assetClassIds],
      p_title: input.title,
    }),
  );
  return result.ok ? ok({ id: result.data as string }) : result;
}

// RFQ request lines ---------------------------------------------------------------------------------------------------

export interface RfqLine {
  readonly id: string;
  readonly lineNumber: number;
  readonly description: string;
  readonly elementId: string | null;
  readonly quantity: number;
  readonly unitBasis: string | null;
  readonly acquisitionKind: AcquisitionKind;
  readonly hireStartsAt: string | null;
  readonly hireEndsAt: string | null;
  readonly procurementNeedId: string | null;
}

export async function listRfqLines(db: XosClient, rfqId: string): Promise<Result<RfqLine[]>> {
  return readRows(
    db
      .from("rfq_lines")
      .select(
        "id, line_number, description, element_id, quantity, unit_basis, acquisition_kind, hire_period, procurement_need_id",
      )
      .eq("rfq_id", rfqId)
      .is("deleted_at", null)
      .order("line_number"),
    (row) => {
      const hire = parseHirePeriod(row.hire_period as string | null);
      return {
        id: row.id,
        lineNumber: row.line_number,
        description: row.description,
        elementId: row.element_id,
        quantity: row.quantity,
        unitBasis: row.unit_basis,
        acquisitionKind: row.acquisition_kind,
        hireStartsAt: hire.startsAt,
        hireEndsAt: hire.endsAt,
        procurementNeedId: row.procurement_need_id,
      };
    },
  );
}

export interface RfqLineInput {
  readonly description: string;
  readonly quantity: number;
  readonly unitBasis: string | null;
  readonly acquisitionKind: AcquisitionKind;
  readonly hireFrom: string | null;
  readonly hireTo: string | null;
}

/** Adds a request line to a Proposed RFQ; the database numbers it. */
export async function addRfqLine(
  db: XosClient,
  rfqId: string,
  input: RfqLineInput,
): Promise<Result<{ id: string }>> {
  return insertedId(
    db
      .from("rfq_lines")
      .insert({
        rfq_id: rfqId,
        description: input.description.trim(),
        quantity: input.quantity,
        unit_basis: blankToNull(input.unitBasis),
        acquisition_kind: input.acquisitionKind,
        hire_period:
          input.acquisitionKind === "Rental" ? neededDuring(input.hireFrom, input.hireTo) : null,
      } as Tables["rfq_lines"]["Insert"])
      .select("id")
      .single(),
  );
}

export async function removeRfqLine(db: XosClient, id: string): Promise<Result<null>> {
  return touched(db.from("rfq_lines").update(deletedNow()).eq("id", id).select("id"));
}

// Chasing ---------------------------------------------------------------------------------------------------------------

/**
 * How an RFQ's quotes are chased. While it is Issued this is only the settings and the due date: with one invited vendor,
 * a count would tell a reader the vendor answered, so the counts stay null until it is Closed or Awarded.
 */
export interface RfqChaseStatus {
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly reminderLimit: number;
  readonly remindersSent: number | null;
  readonly lastRemindedAt: string | null;
}

export async function getRfqChaseStatus(
  db: XosClient,
  rfqId: string,
): Promise<Result<RfqChaseStatus | null>> {
  const { data, error } = await db
    .from("rfq_chase_status")
    .select("chase_enabled, interval_hours, reminder_limit, reminders_sent, last_reminded_at")
    .eq("rfq_id", rfqId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return ok(null);
  return ok({
    enabled: data.chase_enabled ?? true,
    intervalHours: data.interval_hours ?? 48,
    reminderLimit: data.reminder_limit ?? 3,
    remindersSent: data.reminders_sent,
    lastRemindedAt: data.last_reminded_at,
  });
}

/** The invited vendors a chase cannot reach, because no Owner or Admin is on their account: chase them by phone. */
export async function listUnreachableVendorIds(
  db: XosClient,
  rfqId: string,
): Promise<Result<string[]>> {
  const { data, error } = await db.rpc("rfq_vendor_reachability", { p_rfq_id: rfqId });
  if (error) return fail(toDataError(error));
  return ok((data ?? []).filter((r) => !r.reachable).map((r) => r.vendor_id));
}
