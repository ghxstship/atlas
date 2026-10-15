import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";
import { listRecords, type RecordSummary } from "./work.ts";

/**
 * Work orders with bids and punch list items (Section 4.2 Work, migrations 0410 and 0411).
 * A work order's state moves through app.transition_work_order and app.award_work_order; a punch
 * item is a Task record of subtype Execute with its origin and place, so its title, owner, due date
 * and state are read from the record. Bid totals and counts are derived here, never stored, and an
 * unpriced bid stays NULL (Section 3.7).
 */

// Work orders ----------------------------------------------------------------------------------------------

export interface WorkOrder {
  readonly id: string;
  readonly key: string;
  readonly number: number;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly timeZone: string;
  readonly scopeNodeId: string | null;
  readonly recordId: string | null;
  readonly title: string;
  readonly scopeOfWork: string | null;
  readonly urid: string | null;
  readonly locationText: string | null;
  readonly scheduledStartsAt: string | null;
  readonly scheduledEndsAt: string | null;
  readonly estimatedHours: number | null;
  readonly bidDueAt: string | null;
  readonly awardedBidId: string | null;
  readonly state: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly bids: readonly Bid[];
}

export interface Bid {
  readonly id: string;
  readonly workOrderId: string;
  readonly bidderOrganizationId: string | null;
  readonly bidderPersonId: string | null;
  readonly bidderName: string | null;
  /** Minor units of currencyCode; NULL is unpriced, never zero. */
  readonly amountMinor: number | null;
  readonly currencyCode: string;
  readonly estimatedHours: number | null;
  readonly note: string | null;
  readonly submittedAt: string;
  readonly withdrawnAt: string | null;
}

interface WorkOrderRow {
  id: string;
  work_order_number: number;
  project_id: string;
  scope_node_id: string | null;
  record_id: string | null;
  title: string;
  scope_of_work: string | null;
  urid: string | null;
  location_text: string | null;
  scheduled_starts_at: string | null;
  scheduled_ends_at: string | null;
  estimated_hours: number | string | null;
  bid_due_at: string | null;
  awarded_bid_id: string | null;
  work_order_state: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  project: { project_key: string; name: string; time_zone: string } | null;
  bids:
    | {
        id: string;
        work_order_id: string;
        bidder_organization_id: string | null;
        bidder_person_id: string | null;
        amount_minor: number | string | null;
        currency_code: string;
        estimated_hours: number | string | null;
        note: string | null;
        submitted_at: string;
        withdrawn_at: string | null;
        deleted_at: string | null;
        organization: { name: string } | null;
        person: { full_name: string | null } | null;
      }[]
    | null;
}

const WORK_ORDER_COLUMNS =
  "id, work_order_number, project_id, scope_node_id, record_id, title, scope_of_work, urid, location_text, scheduled_starts_at, scheduled_ends_at, estimated_hours, bid_due_at, awarded_bid_id, work_order_state, created_by, created_at, updated_at, project:projects!inner(project_key, name, time_zone), bids:work_order_bids!work_order_bids_work_order_id_fkey(id, work_order_id, bidder_organization_id, bidder_person_id, amount_minor, currency_code, estimated_hours, note, submitted_at, withdrawn_at, deleted_at, organization:organizations!work_order_bids_bidder_organization_id_fkey(name), person:people!work_order_bids_bidder_person_id_fkey(full_name))";

const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

function toWorkOrder(row: WorkOrderRow): WorkOrder {
  const projectKey = row.project?.project_key ?? "";
  return {
    id: row.id,
    key: `${projectKey}-WO-${row.work_order_number}`,
    number: row.work_order_number,
    projectId: row.project_id,
    projectKey,
    projectName: row.project?.name ?? "",
    timeZone: row.project?.time_zone ?? "UTC",
    scopeNodeId: row.scope_node_id,
    recordId: row.record_id,
    title: row.title,
    scopeOfWork: row.scope_of_work,
    urid: row.urid,
    locationText: row.location_text,
    scheduledStartsAt: row.scheduled_starts_at,
    scheduledEndsAt: row.scheduled_ends_at,
    estimatedHours: num(row.estimated_hours),
    bidDueAt: row.bid_due_at,
    awardedBidId: row.awarded_bid_id,
    state: row.work_order_state,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bids: (row.bids ?? [])
      .filter((b) => b.deleted_at === null)
      .map((b) => ({
        id: b.id,
        workOrderId: b.work_order_id,
        bidderOrganizationId: b.bidder_organization_id,
        bidderPersonId: b.bidder_person_id,
        bidderName: b.organization?.name ?? b.person?.full_name ?? null,
        amountMinor: num(b.amount_minor),
        currencyCode: b.currency_code,
        estimatedHours: num(b.estimated_hours),
        note: b.note,
        submittedAt: b.submitted_at,
        withdrawnAt: b.withdrawn_at,
      }))
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)),
  };
}

/** Work order states in lifecycle order (app.work_order_state), read from the transition rules. */
export async function listWorkOrderTransitions(
  db: XosClient,
): Promise<Result<{ from: string; to: string }[]>> {
  const { data, error } = await db
    .from("lifecycle_transition_rules")
    .select("from_state, to_state")
    .eq("lifecycle", "work_order");
  if (error) return fail(toDataError(error));
  return ok(
    data.flatMap((r) =>
      r.from_state && r.to_state ? [{ from: r.from_state, to: r.to_state }] : [],
    ),
  );
}

/** Work orders of the org or a project, by key. */
export async function listWorkOrders(
  db: XosClient,
  query: {
    readonly orgId: string;
    readonly projectId?: string;
    readonly states?: readonly string[];
    readonly search?: string;
  },
): Promise<Result<WorkOrder[]>> {
  let q = untyped(db)
    .from("work_orders")
    .select(WORK_ORDER_COLUMNS)
    .eq("org_id", query.orgId)
    .is("deleted_at", null);
  if (query.projectId) q = q.eq("project_id", query.projectId);
  if (query.states && query.states.length > 0) q = q.in("work_order_state", [...query.states]);
  if (query.search && query.search.trim() !== "") {
    q = q.ilike("title", `%${query.search.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  }
  const { data, error } = await q.order("project_id").order("work_order_number").limit(500);
  if (error) return fail(toDataError(error));
  return ok((data as unknown as WorkOrderRow[]).map(toWorkOrder));
}

export async function getWorkOrder(db: XosClient, id: string): Promise<Result<WorkOrder>> {
  const { data, error } = await untyped(db)
    .from("work_orders")
    .select(WORK_ORDER_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toWorkOrder(data as unknown as WorkOrderRow));
}

export interface WorkOrderInput {
  readonly title: string;
  readonly scopeOfWork?: string | null;
  readonly scopeNodeId?: string | null;
  readonly recordId?: string | null;
  readonly urid?: string | null;
  readonly locationText?: string | null;
  readonly scheduledStartsAt?: string | null;
  readonly scheduledEndsAt?: string | null;
  readonly estimatedHours?: number | null;
  readonly bidDueAt?: string | null;
}

function workOrderRow(input: Partial<WorkOrderInput>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (input.title !== undefined) row["title"] = input.title.trim();
  if (input.scopeOfWork !== undefined) row["scope_of_work"] = input.scopeOfWork?.trim() || null;
  if (input.scopeNodeId !== undefined) row["scope_node_id"] = input.scopeNodeId;
  if (input.recordId !== undefined) row["record_id"] = input.recordId;
  if (input.urid !== undefined) row["urid"] = input.urid;
  if (input.locationText !== undefined) row["location_text"] = input.locationText?.trim() || null;
  if (input.scheduledStartsAt !== undefined) row["scheduled_starts_at"] = input.scheduledStartsAt;
  if (input.scheduledEndsAt !== undefined) row["scheduled_ends_at"] = input.scheduledEndsAt;
  if (input.estimatedHours !== undefined) row["estimated_hours"] = input.estimatedHours;
  if (input.bidDueAt !== undefined) row["bid_due_at"] = input.bidDueAt;
  return row;
}

/** Creates a Draft work order; the database issues its number. */
export async function createWorkOrder(
  db: XosClient,
  input: WorkOrderInput & { readonly orgId: string; readonly projectId: string },
): Promise<Result<{ id: string; number: number }>> {
  const { data, error } = await untyped(db)
    .from("work_orders")
    .insert({ ...workOrderRow(input), org_id: input.orgId, project_id: input.projectId })
    .select("id, work_order_number")
    .single();
  if (error) return fail(toDataError(error));
  const row = data as { id: string; work_order_number: number };
  return ok({ id: row.id, number: row.work_order_number });
}

export async function updateWorkOrder(
  db: XosClient,
  id: string,
  patch: Partial<WorkOrderInput>,
): Promise<Result<null>> {
  const row = workOrderRow(patch);
  if (Object.keys(row).length === 0) return ok(null);
  const { data, error } = await untyped(db)
    .from("work_orders")
    .update(row)
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data as unknown[]).length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** Moves a work order to another state (app.transition_work_order, compare-and-set). */
export async function transitionWorkOrder(
  db: XosClient,
  input: {
    readonly id: string;
    readonly expected: string;
    readonly next: string;
    readonly reason: string;
  },
): Promise<Result<null>> {
  const { error } = await untyped(db).rpc("transition_work_order", {
    p_work_order_id: input.id,
    p_expected: input.expected,
    p_next: input.next,
    p_reason: input.reason,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Awards a work order to one of its bids (app.award_work_order). The creator cannot award. */
export async function awardWorkOrder(
  db: XosClient,
  input: { readonly id: string; readonly bidId: string; readonly reason: string },
): Promise<Result<null>> {
  const { error } = await untyped(db).rpc("award_work_order", {
    p_work_order_id: input.id,
    p_bid_id: input.bidId,
    p_reason: input.reason,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Deletes a Draft work order; any other state refuses (cancel it instead). */
export async function deleteWorkOrder(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from("work_orders")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data as unknown[]).length === 1 ? ok(null) : fail({ kind: "not-found" });
}

// Bids --------------------------------------------------------------------------------------------------

/** Records a bid. Leave the amount empty for a bid without a price (Unpriced). */
export async function addBid(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly workOrderId: string;
    readonly bidderOrganizationId?: string | null;
    readonly bidderPersonId?: string | null;
    readonly amountMinor: number | null;
    readonly currencyCode: string;
    readonly estimatedHours?: number | null;
    readonly note?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await untyped(db)
    .from("work_order_bids")
    .insert({
      org_id: input.orgId,
      work_order_id: input.workOrderId,
      bidder_organization_id: input.bidderOrganizationId ?? null,
      bidder_person_id: input.bidderPersonId ?? null,
      amount_minor: input.amountMinor,
      currency_code: input.currencyCode,
      estimated_hours: input.estimatedHours ?? null,
      note: input.note?.trim() || null,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: (data as { id: string }).id });
}

export async function updateBid(
  db: XosClient,
  id: string,
  patch: {
    readonly amountMinor?: number | null;
    readonly note?: string | null;
    readonly withdraw?: boolean;
  },
): Promise<Result<null>> {
  const row: Record<string, unknown> = {};
  if (patch.amountMinor !== undefined) row["amount_minor"] = patch.amountMinor;
  if (patch.note !== undefined) row["note"] = patch.note?.trim() || null;
  if (patch.withdraw) row["withdrawn_at"] = new Date().toISOString();
  const { data, error } = await untyped(db)
    .from("work_order_bids")
    .update(row)
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data as unknown[]).length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export interface BidSummary {
  readonly live: number;
  readonly priced: number;
  readonly unpriced: number;
  /** Lowest priced live bid per currency; absent when no live bid in it is priced. */
  readonly lowest: ReadonlyMap<string, number>;
}

/** Counts and the lowest price of a work order's live bids, NULL-aware (Section 3.7). */
export function summarizeBids(bids: readonly Bid[]): BidSummary {
  const live = bids.filter((b) => b.withdrawnAt === null);
  const lowest = new Map<string, number>();
  for (const b of live) {
    if (b.amountMinor === null) continue;
    const current = lowest.get(b.currencyCode);
    if (current === undefined || b.amountMinor < current) lowest.set(b.currencyCode, b.amountMinor);
  }
  const priced = live.filter((b) => b.amountMinor !== null).length;
  return { live: live.length, priced, unpriced: live.length - priced, lowest };
}

/** Organizations that may bid: the org's counterparties, by name. */
export async function listBidderOptions(
  db: XosClient,
  orgId: string,
): Promise<Result<{ organizationId: string; name: string }[]>> {
  const { data, error } = await db
    .from("counterparties")
    .select("organization_id, organization:organizations!counterparties_organization_id_fkey(name)")
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as { organization_id: string; organization: { name: string } | null }[])
      .map((c) => ({
        organizationId: c.organization_id,
        name: c.organization?.name ?? c.organization_id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

// Punch items ---------------------------------------------------------------------------------------------

export interface PunchItem {
  readonly id: string;
  readonly record: RecordSummary;
  readonly sourceRecordId: string | null;
  readonly inspectionResultId: string | null;
  readonly zoneId: string | null;
  readonly zoneName: string | null;
  readonly sitePlanPinId: string | null;
  readonly locationText: string | null;
}

/** Punch items of the org or a project, with their Task records. */
export async function listPunchItems(
  db: XosClient,
  query: {
    readonly orgId: string;
    readonly projectId?: string;
    readonly states?: readonly string[];
  },
): Promise<Result<PunchItem[]>> {
  const { data, error } = await untyped(db)
    .from("punch_items")
    .select(
      "id, record_id, source_record_id, inspection_result_id, zone_id, site_plan_pin_id, location_text, zone:zones(name)",
    )
    .eq("org_id", query.orgId)
    .is("deleted_at", null)
    .limit(1000);
  if (error) return fail(toDataError(error));
  const rows = data as unknown as {
    id: string;
    record_id: string;
    source_record_id: string | null;
    inspection_result_id: string | null;
    zone_id: string | null;
    site_plan_pin_id: string | null;
    location_text: string | null;
    zone: { name: string } | null;
  }[];
  if (rows.length === 0) return ok([]);
  const records = await listRecords(db, {
    orgId: query.orgId,
    ids: rows.map((r) => r.record_id),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.states ? { states: query.states } : {}),
  });
  if (!records.ok) return records;
  const byId = new Map(records.data.map((r) => [r.id, r]));
  return ok(
    rows
      .flatMap((r) => {
        const record = byId.get(r.record_id);
        return record
          ? [
              {
                id: r.id,
                record,
                sourceRecordId: r.source_record_id,
                inspectionResultId: r.inspection_result_id,
                zoneId: r.zone_id,
                zoneName: r.zone?.name ?? null,
                sitePlanPinId: r.site_plan_pin_id,
                locationText: r.location_text,
              },
            ]
          : [];
      })
      .sort(
        (a, b) =>
          a.record.projectKey.localeCompare(b.record.projectKey) ||
          a.record.number - b.record.number,
      ),
  );
}

/** The punch facts of a record, when the record is a punch item's Task. */
export async function getPunchItemForRecord(
  db: XosClient,
  recordId: string,
): Promise<
  Result<{ id: string; sourceRecordId: string | null; locationText: string | null } | null>
> {
  const { data, error } = await untyped(db)
    .from("punch_items")
    .select("id, source_record_id, location_text")
    .eq("record_id", recordId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  const row = data as {
    id: string;
    source_record_id: string | null;
    location_text: string | null;
  } | null;
  return ok(
    row
      ? { id: row.id, sourceRecordId: row.source_record_id, locationText: row.location_text }
      : null,
  );
}

/** Raises a punch item and its Task record (app.create_punch_item). */
export async function createPunchItem(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly what: string;
    readonly sourceRecordId?: string | null;
    readonly zoneId?: string | null;
    readonly locationText?: string | null;
    readonly ownerId?: string | null;
    readonly dueAt?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await untyped(db).rpc("create_punch_item", {
    p_project_id: input.projectId,
    p_what: input.what,
    p_source_record_id: input.sourceRecordId ?? null,
    p_zone_id: input.zoneId ?? null,
    p_location_text: input.locationText ?? null,
    p_owner_party_id: input.ownerId ?? null,
    p_due_at: input.dueAt ?? null,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: String(data) });
}
