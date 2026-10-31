import type { BulkOutcome, BulkRow } from "./bulk.ts";
import { toBulkOutcome } from "./bulk.ts";
import type { Database, Json } from "./database.types.ts";
import { external, req, type EngagementArea, type ExternalRow } from "./gateway-external.ts";
import { toDisplayKey } from "./gateway-keys.ts";
import type { Engagement, XosClient } from "./gateway.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Allocations in Gateway (R8, migrations 2700 to 2702, ADR 0103 and 0104), imported as
 * `@xos/data/gateway-allocations`. The party side of an engagement (its Owner or Admin, an Advancing
 * Lead, an Advance representative, the engaged person of an Artist engagement) asks for what its pool
 * or one person needs and shares an approved pool out to its people; a person on a roster reads their
 * own share, parking passes and the engagements they reach only through the roster. Status is the
 * computed display_status (owner decision 8): possession is confirmed only by Issue, in Atlas or Compass.
 *
 * Every read goes through api_external (no price, order number, vendor or plate); every write is an
 * RPC whose refusals come back as typed errors with the rule the database named.
 */

type Enums = Database["app"]["Enums"];
export type AllocationState = Enums["allocation_state"];
export type AllocationServiceKind = Enums["allocation_service_kind"];
export type OfferingKind = Enums["offering_kind"];

/** What an allocation gives: Credential, Parking Pass, Asset, Catering, Lodging, Travel or Per Diem. */
export type AllocationKind =
  "Credential" | "Parking Pass" | "Asset" | "Catering" | "Lodging" | "Travel" | "Per Diem";

/** The computed status of 2695, in its order. */
export const DISPLAY_STATUSES = [
  "Requested",
  "Approved",
  "Reserved",
  "Received",
  "Confirmed",
  "On Order",
  "Awaiting Order",
  "Partly Issued",
  "Issued",
  "Revoked",
  "Returned",
  "Declined",
  "Withdrawn",
] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

/** Statuses of an approved allocation not yet in the person's hands: what they pick up. */
export const PENDING_PICKUP_STATUSES: readonly DisplayStatus[] = [
  "Approved",
  "Reserved",
  "Awaiting Order",
  "On Order",
  "Confirmed",
  "Received",
];

/** The item kinds app.request_engaged_allocation takes. */
export const REQUEST_ITEM_KINDS = [
  "credential_category",
  "asset_class",
  "fulfillment",
  "accommodation_block",
  "service",
] as const;
export type RequestItemKind = (typeof REQUEST_ITEM_KINDS)[number];

export interface EngagedAllocation {
  readonly id: string;
  readonly engagementId: string;
  /** Null for the party's pool. */
  readonly rosterEntryId: string | null;
  readonly personName: string | null;
  readonly kind: AllocationKind;
  /** Null for Travel and Per Diem. */
  readonly itemName: string | null;
  readonly quantity: number;
  readonly state: AllocationState;
  readonly status: DisplayStatus;
  readonly reservedQuantity: number;
  readonly issuedQuantity: number;
  readonly returnedQuantity: number;
  readonly parentAllocationId: string | null;
  readonly neededFrom: string;
  readonly neededTo: string;
  readonly neededTimeZone: string;
  readonly requestedByMe: boolean;
  readonly declineReason: string | null;
}

const ALLOCATION_COLUMNS =
  "allocation_id, engagement_id, roster_entry_id, person_name, kind, item_name, quantity, allocation_state, display_status, reserved_quantity, issued_quantity, returned_quantity, parent_allocation_id, needed_from, needed_to, needed_time_zone, requested_by_me, decline_reason";

function toAllocation(row: ExternalRow<"advance_allocations">): EngagedAllocation {
  return {
    id: req(row.allocation_id, "advance_allocations.allocation_id"),
    engagementId: req(row.engagement_id, "advance_allocations.engagement_id"),
    rosterEntryId: row.roster_entry_id,
    personName: row.person_name,
    kind: req(row.kind, "advance_allocations.kind") as AllocationKind,
    itemName: row.item_name,
    quantity: Number(req(row.quantity, "advance_allocations.quantity")),
    state: req(row.allocation_state, "advance_allocations.allocation_state"),
    status: req(row.display_status, "advance_allocations.display_status") as DisplayStatus,
    reservedQuantity: Number(row.reserved_quantity ?? 0),
    issuedQuantity: Number(row.issued_quantity ?? 0),
    returnedQuantity: Number(row.returned_quantity ?? 0),
    parentAllocationId: row.parent_allocation_id,
    neededFrom: req(row.needed_from, "advance_allocations.needed_from"),
    neededTo: req(row.needed_to, "advance_allocations.needed_to"),
    neededTimeZone: req(row.needed_time_zone, "advance_allocations.needed_time_zone"),
    requestedByMe: row.requested_by_me ?? false,
    declineReason: row.decline_reason,
  };
}

/** Live means Requested or Approved: what still counts toward an engagement's needs. */
export function isLiveAllocation(a: Pick<EngagedAllocation, "state">): boolean {
  return a.state === "Requested" || a.state === "Approved";
}

/** The party's pool: approved allocations it holds, with something left to share out. */
export function poolAllocations(rows: readonly EngagedAllocation[]): EngagedAllocation[] {
  return rows.filter((a) => a.rosterEntryId === null && a.state === "Approved");
}

/** One person's approved share of one pool: the sum of their live shares of it. */
export function shareOf(
  rows: readonly EngagedAllocation[],
  poolId: string,
  rosterEntryId: string,
): number {
  return rows
    .filter(
      (a) =>
        a.parentAllocationId === poolId &&
        a.rosterEntryId === rosterEntryId &&
        a.state === "Approved",
    )
    .reduce((n, a) => n + a.quantity, 0);
}

/** Every allocation of an engagement the caller answers for: the pool and each person's rows. */
export async function listEngagementAllocations(
  db: XosClient,
  engagementId: string,
): Promise<Result<EngagedAllocation[]>> {
  const { data, error } = await external(db)
    .from("advance_allocations")
    .select(ALLOCATION_COLUMNS)
    .eq("engagement_id", engagementId)
    .order("needed_from", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(data.flatMap((r) => (r.allocation_id ? [toAllocation(r)] : [])));
}

/** The caller's own allocations on their roster entries, of one engagement or all. */
export async function listMyAllocations(
  db: XosClient,
  rosterEntryIds: readonly string[],
): Promise<Result<EngagedAllocation[]>> {
  if (rosterEntryIds.length === 0) return ok([]);
  const { data, error } = await external(db)
    .from("advance_allocations")
    .select(ALLOCATION_COLUMNS)
    .in("roster_entry_id", [...rosterEntryIds])
    .order("needed_from", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(data.flatMap((r) => (r.allocation_id ? [toAllocation(r)] : [])));
}

// Requestable items ------------------------------------------------------------------------------

export interface RequestableItem {
  readonly engagementId: string;
  readonly itemKind: RequestItemKind;
  /** Null for a service (Travel or Per Diem). */
  readonly itemId: string | null;
  /** The item's name; Travel or Per Diem for a service. */
  readonly name: string;
  /** Null for an Access badge, which is no offering. */
  readonly offering: OfferingKind | null;
  readonly capPerEngagement: number | null;
  readonly capPerPerson: number | null;
  readonly requestedQuantity: number;
}

/** What the party side may ask for on an engagement (owner decision 7: only offered items). */
export async function listRequestableItems(
  db: XosClient,
  engagementId: string,
): Promise<Result<RequestableItem[]>> {
  const { data, error } = await external(db)
    .from("requestable_items")
    .select(
      "engagement_id, item_kind, item_id, name, offering, cap_per_engagement, cap_per_person, requested_quantity",
    )
    .eq("engagement_id", engagementId)
    .order("item_kind", { ascending: true })
    .order("name", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      engagementId: req(r.engagement_id, "requestable_items.engagement_id"),
      itemKind: req(r.item_kind, "requestable_items.item_kind") as RequestItemKind,
      itemId: r.item_id,
      name: req(r.name, "requestable_items.name"),
      offering: r.offering,
      capPerEngagement: r.cap_per_engagement,
      capPerPerson: r.cap_per_person,
      requestedQuantity: Number(r.requested_quantity ?? 0),
    })),
  );
}

/** A requestable item's form value: its kind and id, or the service it names. */
export function requestableValue(item: Pick<RequestableItem, "itemKind" | "itemId" | "name">) {
  return item.itemKind === "service" ? `service:${item.name}` : `${item.itemKind}:${item.itemId}`;
}

/** The kind, id and service a form value names; null for anything else. */
export function parseRequestableValue(value: string): {
  readonly itemKind: RequestItemKind;
  readonly itemId: string | null;
  readonly serviceKind: AllocationServiceKind | null;
} | null {
  const at = value.indexOf(":");
  if (at <= 0) return null;
  const kind = value.slice(0, at);
  const rest = value.slice(at + 1);
  if (!(REQUEST_ITEM_KINDS as readonly string[]).includes(kind) || rest === "") return null;
  if (kind === "service") {
    return rest === "Travel" || rest === "Per Diem"
      ? { itemKind: "service", itemId: null, serviceKind: rest }
      : null;
  }
  return { itemKind: kind as RequestItemKind, itemId: rest, serviceKind: null };
}

// Writes -----------------------------------------------------------------------------------------

export interface EngagedAllocationRequest {
  readonly engagementId: string;
  /** Null asks for the party's pool. */
  readonly rosterEntryId: string | null;
  readonly itemKind: RequestItemKind;
  readonly itemId: string | null;
  readonly serviceKind: AllocationServiceKind | null;
  readonly quantity: number;
  readonly neededFrom: string;
  readonly neededTo: string;
  readonly timeZone: string;
  readonly note: string | null;
}

/** Asks for an item for the pool or one person (app.request_engaged_allocation). Returns its id. */
export async function requestEngagedAllocation(
  db: XosClient,
  input: EngagedAllocationRequest,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("request_engaged_allocation", {
    p_engagement_id: input.engagementId,
    p_item_kind: input.itemKind,
    p_quantity: input.quantity,
    p_needed_from: input.neededFrom,
    p_needed_to: input.neededTo,
    p_time_zone: input.timeZone,
    ...(input.rosterEntryId ? { p_roster_entry_id: input.rosterEntryId } : {}),
    ...(input.itemId ? { p_item_id: input.itemId } : {}),
    ...(input.serviceKind ? { p_service_kind: input.serviceKind } : {}),
    ...(input.note ? { p_note: input.note } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** Shares an approved pool to people on the roster (app.split_engaged_allocation). */
export async function splitEngagedAllocation(
  db: XosClient,
  poolAllocationId: string,
  parts: readonly { readonly rosterEntryId: string; readonly quantity: number }[],
): Promise<Result<string[]>> {
  const { data, error } = await db.rpc("split_engaged_allocation", {
    p_pool_allocation_id: poolAllocationId,
    p_parts: parts.map((p) => ({ roster_entry_id: p.rosterEntryId, quantity: p.quantity })) as Json,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** Gives part or all of a person's share back to the pool (app.unsplit_engaged_allocation). */
export async function unsplitEngagedAllocation(
  db: XosClient,
  shareId: string,
  quantity?: number,
): Promise<Result<number>> {
  const { data, error } = await db.rpc("unsplit_engaged_allocation", {
    p_child_id: shareId,
    ...(quantity !== undefined ? { p_quantity: quantity } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(Number(data));
}

/** Withdraws a Requested allocation, or an Approved one nothing of which was issued. */
export async function withdrawEngagedAllocation(
  db: XosClient,
  allocationId: string,
  reason: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("withdraw_engaged_allocation", {
    p_allocation_id: allocationId,
    p_reason: reason,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/**
 * Sets each selected person's share of one pool in one all-or-nothing call
 * (app.bulk_update_engaged_allocation_assignments): a higher quantity splits the difference from
 * the pool, a lower one gives shares back newest first. With `preview` nothing changes.
 */
export async function bulkAssignFromPool(
  db: XosClient,
  rows: readonly BulkRow[],
  options: { readonly preview?: boolean; readonly reason?: string | null } = {},
): Promise<Result<BulkOutcome>> {
  const { data, error } = await db.rpc("bulk_update_engaged_allocation_assignments", {
    p_rows: rows as unknown as Json,
    p_preview: options.preview ?? false,
    ...(options.reason ? { p_reason: options.reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(toBulkOutcome(data));
}

// Parking passes -----------------------------------------------------------------------------------

export interface ParkingPass {
  readonly credentialId: string;
  readonly projectId: string;
  readonly credentialNumber: string | null;
  readonly categoryName: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly revokedAt: string | null;
  readonly zoneCodes: readonly string[];
  readonly zoneNames: readonly string[];
  readonly vehicleMake: string | null;
  readonly vehicleModel: string | null;
  readonly vehicleColor: string | null;
}

/** The caller's own parking passes, of one project or all; never the plate. */
export async function listMyParkingPasses(
  db: XosClient,
  projectId?: string,
): Promise<Result<ParkingPass[]>> {
  let query = external(db)
    .from("my_parking_passes")
    .select(
      "credential_id, project_id, credential_number, category_name, valid_from, valid_to, revoked_at, zone_codes, zone_names, vehicle_make, vehicle_model, vehicle_color",
    );
  if (projectId !== undefined) query = query.eq("project_id", projectId);
  const { data, error } = await query.order("valid_from", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      credentialId: req(r.credential_id, "my_parking_passes.credential_id"),
      projectId: req(r.project_id, "my_parking_passes.project_id"),
      credentialNumber: r.credential_number,
      categoryName: req(r.category_name, "my_parking_passes.category_name"),
      validFrom: r.valid_from,
      validTo: r.valid_to,
      revokedAt: r.revoked_at,
      zoneCodes: r.zone_codes ?? [],
      zoneNames: r.zone_names ?? [],
      vehicleMake: r.vehicle_make,
      vehicleModel: r.vehicle_model,
      vehicleColor: r.vehicle_color,
    })),
  );
}

/** A pass in one line: its zone names, then the vehicle's make, model and colour. */
export function parkingLine(pass: ParkingPass): string {
  const vehicle = [pass.vehicleMake, pass.vehicleModel, pass.vehicleColor]
    .map((v) => v?.trim() ?? "")
    .filter((v) => v !== "")
    .join(" ");
  const zones = pass.zoneNames.join(", ") || pass.categoryName;
  return vehicle ? `${zones} · ${vehicle}` : zones;
}

// Engagements through a roster entry ------------------------------------------------------------------

/** An engagement the caller reaches only through an Accepted roster entry (ADR 0100 roster-member). */
export interface RosterEngagement extends Engagement {
  readonly rosterEntryId: string;
  readonly entryRoleCode: string | null;
  readonly arrivalStartsAt: string | null;
  readonly arrivalEndsAt: string | null;
  readonly arrivalTimeZone: string | null;
  /** Whom to ask on the party side: its Advancing Lead, else its Account Owner. */
  readonly leadName: string | null;
}

const ROSTER_ENGAGEMENT_COLUMNS =
  "id, org_id, org_name, project_id, project_name, role_type, role_code, job_title, person_id, account_id, pay_basis, arrangement, start_date, end_date, engagement_state, areas, project_time_zone, roster_locks_at, roster_entry_id, entry_role_code, arrival_window_start, arrival_window_end, arrival_time_zone, lead_name";

type RosterEngagementRow = Pick<
  ExternalRow<"my_roster_engagements">,
  | "id"
  | "org_id"
  | "org_name"
  | "project_id"
  | "project_name"
  | "role_type"
  | "role_code"
  | "job_title"
  | "person_id"
  | "account_id"
  | "pay_basis"
  | "arrangement"
  | "start_date"
  | "end_date"
  | "engagement_state"
  | "areas"
  | "project_time_zone"
  | "roster_locks_at"
  | "roster_entry_id"
  | "entry_role_code"
  | "arrival_window_start"
  | "arrival_window_end"
  | "arrival_time_zone"
  | "lead_name"
>;

function toRosterEngagement(row: RosterEngagementRow): RosterEngagement {
  const id = req(row.id, "my_roster_engagements.id");
  return {
    id,
    key: toDisplayKey("engagement", id),
    orgId: req(row.org_id, "my_roster_engagements.org_id"),
    orgName: req(row.org_name, "my_roster_engagements.org_name"),
    projectId: req(row.project_id, "my_roster_engagements.project_id"),
    projectName: req(row.project_name, "my_roster_engagements.project_name"),
    roleType: req(row.role_type, "my_roster_engagements.role_type"),
    roleCode: row.role_code,
    jobTitle: row.job_title,
    personId: row.person_id,
    accountId: row.account_id,
    payBasis: row.pay_basis,
    arrangement: row.arrangement,
    // The party's rate is never the person's.
    rateMinor: null,
    rateCurrency: null,
    startDate: req(row.start_date, "my_roster_engagements.start_date"),
    endDate: row.end_date,
    state: req(row.engagement_state, "my_roster_engagements.engagement_state"),
    areas: (row.areas ?? []) as EngagementArea[],
    projectTimeZone: req(row.project_time_zone, "my_roster_engagements.project_time_zone"),
    rosterLocksAt: row.roster_locks_at,
    rosterEntryId: req(row.roster_entry_id, "my_roster_engagements.roster_entry_id"),
    entryRoleCode: row.entry_role_code,
    arrivalStartsAt: row.arrival_window_start,
    arrivalEndsAt: row.arrival_window_end,
    arrivalTimeZone: row.arrival_time_zone,
    leadName: row.lead_name,
  };
}

/** The engagements the caller reaches only through a roster entry, by start date. */
export async function listMyRosterEngagements(db: XosClient): Promise<Result<RosterEngagement[]>> {
  const { data, error } = await external(db)
    .from("my_roster_engagements")
    .select(ROSTER_ENGAGEMENT_COLUMNS)
    .order("start_date", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(data.map(toRosterEngagement));
}

/** One engagement reached through a roster entry, or not-found. */
export async function getMyRosterEngagement(
  db: XosClient,
  id: string,
): Promise<Result<RosterEngagement>> {
  const { data, error } = await external(db)
    .from("my_roster_engagements")
    .select(ROSTER_ENGAGEMENT_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toRosterEngagement(data));
}
