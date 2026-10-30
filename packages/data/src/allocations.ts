import { bulkUpdate, sameValueRows, type BulkOutcome } from "./bulk.ts";
import type { Database, XosClient } from "./client.ts";
import { Constants, type Json } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Advance allocations (R7, migrations 2690 to 2697, ADR 0103 and 0104), imported as `@xos/data/allocations`. A
 * production allocates badges, parking passes, radios and carts, catering, rooms, trips and per diems to a party's
 * pool or to one person on its roster; a reviewer who did not request it approves or declines it; approval holds the
 * asset stock (class stock, a pinned unit, a lot or an order line); a pool is split to its people; Issue hands the
 * item over and confirms possession by the intended person.
 *
 * Requested, Approved, Declined and Withdrawn are stored; everything else (held, ordered, confirmed, received,
 * issued, returned, revoked) is computed by app.advance_allocation_status from the rows that own it, and read here
 * as the display status. Every write is an RPC; refusals come back as typed errors with the rule the database named.
 */

type Enums = Database["app"]["Enums"];
export type AllocationState = Enums["allocation_state"];
export type AllocationOrigin = Enums["allocation_origin"];
export type AllocationServiceKind = Enums["allocation_service_kind"];
export type OfferingKind = Enums["offering_kind"];

export const ALLOCATION_STATES: readonly AllocationState[] = Constants.app.Enums.allocation_state;

/** What an allocation gives, from its target (app.advance_allocation_status.kind). */
export const ALLOCATION_KINDS = [
  "Credential",
  "Parking Pass",
  "Asset",
  "Catering",
  "Lodging",
  "Travel",
  "Per Diem",
] as const;
export type AllocationKind = (typeof ALLOCATION_KINDS)[number];

/** The computed status, in the view's order of precedence after the stored states. */
export const ALLOCATION_DISPLAY_STATUSES = [
  "Requested",
  "Approved",
  "Reserved",
  "Awaiting Order",
  "On Order",
  "Confirmed",
  "Received",
  "Partly Issued",
  "Issued",
  "Returned",
  "Revoked",
  "Declined",
  "Withdrawn",
] as const;
export type AllocationDisplayStatus = (typeof ALLOCATION_DISPLAY_STATUSES)[number];

const isOne = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

/** One allocation with its computed status, as the producing org reads it. */
export interface Allocation {
  readonly id: string;
  readonly projectId: string;
  /** The party pool's engagement; null when one person holds it. */
  readonly holderEngagementId: string | null;
  readonly rosterEntryId: string | null;
  readonly parentAllocationId: string | null;
  readonly kind: AllocationKind;
  readonly offering: OfferingKind | null;
  readonly itemName: string | null;
  readonly quantity: number;
  readonly state: AllocationState;
  readonly origin: AllocationOrigin;
  readonly neededFrom: string | null;
  readonly neededTo: string | null;
  readonly timeZone: string;
  readonly requestedBy: string | null;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly declineReason: string | null;
  readonly reservedQuantity: number;
  readonly onOrderQuantity: number;
  readonly confirmed: boolean;
  readonly awaitingOrder: boolean;
  readonly receivedQuantity: number;
  readonly issuedQuantity: number;
  readonly returnedQuantity: number;
  readonly lostQuantity: number;
  readonly revokedQuantity: number;
  readonly status: AllocationDisplayStatus;
}

const STATUS_COLUMNS =
  "allocation_id, project_id, holder_engagement_id, roster_entry_id, parent_allocation_id, kind, offering, item_name, quantity, allocation_state, origin, needed_during, needed_time_zone, requested_by, decided_at, decided_by, decline_reason, reserved_quantity, on_order_quantity, confirmed, awaiting_order, received_quantity, issued_quantity, returned_quantity, lost_quantity, revoked_quantity, display_status";

type StatusRow = Database["app"]["Views"]["advance_allocation_status"]["Row"];

/**
 * The two bounds of a tstzrange literal such as `["2027-06-01 12:00:00+00","2027-06-05 12:00:00+00")`, as ISO
 * instants; null for an unbounded or unreadable side.
 */
export function rangeBounds(range: string | null | undefined): {
  readonly from: string | null;
  readonly to: string | null;
} {
  const match = /^[[(]"?([^",]*)"?,"?([^",]*)"?[\])]$/.exec((range ?? "").trim());
  if (!match) return { from: null, to: null };
  const iso = (v: string | undefined) => {
    if (!v) return null;
    const t = Date.parse(v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  };
  return { from: iso(match[1]), to: iso(match[2]) };
}

const num = (v: number | string | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

/** A view row in camel case; a row without its keys (never in practice) is dropped. */
export function toAllocation(r: StatusRow): Allocation | null {
  if (r.allocation_id === null || r.project_id === null || r.allocation_state === null) return null;
  if (!isOne(ALLOCATION_KINDS, r.kind)) return null;
  const window = rangeBounds(r.needed_during as string | null);
  return {
    id: r.allocation_id,
    projectId: r.project_id,
    holderEngagementId: r.holder_engagement_id,
    rosterEntryId: r.roster_entry_id,
    parentAllocationId: r.parent_allocation_id,
    kind: r.kind,
    offering: r.offering,
    itemName: r.item_name,
    quantity: num(r.quantity),
    state: r.allocation_state,
    origin: r.origin ?? "Requested",
    neededFrom: window.from,
    neededTo: window.to,
    timeZone: r.needed_time_zone ?? "UTC",
    requestedBy: r.requested_by,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    declineReason: r.decline_reason,
    reservedQuantity: num(r.reserved_quantity),
    onOrderQuantity: num(r.on_order_quantity),
    confirmed: r.confirmed === true,
    awaitingOrder: r.awaiting_order === true,
    receivedQuantity: num(r.received_quantity),
    issuedQuantity: num(r.issued_quantity),
    returnedQuantity: num(r.returned_quantity),
    lostQuantity: num(r.lost_quantity),
    revokedQuantity: num(r.revoked_quantity),
    status: isOne(ALLOCATION_DISPLAY_STATUSES, r.display_status) ? r.display_status : "Approved",
  };
}

const allocations = (rows: readonly StatusRow[] | null): Allocation[] =>
  (rows ?? []).flatMap((r) => {
    const a = toAllocation(r);
    return a ? [a] : [];
  });

/** The allocations of an org, or of one project, newest first. */
export async function listAllocations(
  db: XosClient,
  scope: {
    readonly orgId: string;
    readonly projectId?: string | null;
    readonly engagementId?: string | null;
    readonly kind?: AllocationKind | null;
    readonly status?: AllocationDisplayStatus | null;
    readonly limit?: number;
  },
): Promise<Result<Allocation[]>> {
  let query = db.from("advance_allocation_status").select(STATUS_COLUMNS).eq("org_id", scope.orgId);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  if (scope.engagementId) query = query.eq("holder_engagement_id", scope.engagementId);
  if (scope.kind) query = query.eq("kind", scope.kind);
  if (scope.status) query = query.eq("display_status", scope.status);
  const { data, error } = await query
    .order("allocation_id", { ascending: false })
    .limit(scope.limit ?? 500);
  if (error) return fail(toDataError(error));
  return ok(allocations(data as StatusRow[] | null));
}

export async function getAllocation(db: XosClient, id: string): Promise<Result<Allocation>> {
  const { data, error } = await db
    .from("advance_allocation_status")
    .select(STATUS_COLUMNS)
    .eq("allocation_id", id)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  const a = data ? toAllocation(data as StatusRow) : null;
  return a ? ok(a) : fail({ kind: "not-found" });
}

/** Someone an allocation can go to: a party's pool, or a person on its roster. */
export interface AllocationHolder {
  readonly kind: "Pool" | "Person";
  readonly engagementId: string;
  readonly rosterEntryId: string | null;
  readonly projectId: string;
  readonly holderName: string | null;
  readonly partyName: string | null;
  readonly roleType: Enums["external_role_type"] | null;
  readonly entryState: Enums["roster_entry_state"] | null;
  readonly personResponse: Enums["roster_person_response"] | null;
  readonly roleCode: string | null;
}

/** The pools and people of a project for the Assign picker (app.allocation_holders), parties first. */
export async function listAllocationHolders(
  db: XosClient,
  projectId: string,
): Promise<Result<AllocationHolder[]>> {
  const { data, error } = await db
    .from("allocation_holders")
    .select(
      "holder_kind, engagement_id, roster_entry_id, project_id, holder_name, party_name, role_type, entry_state, person_response, role_code",
    )
    .eq("project_id", projectId)
    .order("party_name", { ascending: true })
    .order("holder_kind", { ascending: false })
    .order("holder_name", { ascending: true, nullsFirst: false });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).flatMap((r) =>
      r.engagement_id === null || r.project_id === null
        ? []
        : [
            {
              kind: r.holder_kind === "Person" ? "Person" : "Pool",
              engagementId: r.engagement_id,
              rosterEntryId: r.roster_entry_id,
              projectId: r.project_id,
              holderName: r.holder_name,
              partyName: r.party_name,
              roleType: r.role_type,
              entryState: r.entry_state,
              personResponse: r.person_response,
              roleCode: r.role_code,
            } satisfies AllocationHolder,
          ],
    ),
  );
}

// Writing -------------------------------------------------------------------------------------------------------

/** What an allocation is for: exactly one target. */
export type AllocationTarget =
  | { readonly kind: "credential"; readonly credentialCategoryId: string }
  | { readonly kind: "asset"; readonly assetClassId: string }
  | { readonly kind: "catering"; readonly fulfillmentId: string }
  | { readonly kind: "lodging"; readonly accommodationBlockId: string }
  | { readonly kind: "service"; readonly serviceKind: AllocationServiceKind };

/** Who holds it: a party's pool (an engagement) or one person (a roster entry). */
export type AllocationHolderRef =
  | { readonly engagementId: string; readonly rosterEntryId?: null }
  | { readonly rosterEntryId: string; readonly engagementId?: null };

export interface AllocationInput {
  readonly projectId: string;
  readonly holder: AllocationHolderRef;
  readonly target: AllocationTarget;
  readonly quantity: number;
  readonly neededFrom: string;
  readonly neededTo: string;
  readonly timeZone: string;
  /** For an assignment above the allowance with overflow at review, the reason that goes in the ledger. */
  readonly note?: string | null;
}

/** One hold source when approving or assigning an asset allocation. */
export type ReservationSource =
  | { readonly source: "Class Stock"; readonly quantity: number }
  | { readonly source: "Unit"; readonly quantity: 1; readonly assetUnitId: string }
  | { readonly source: "Lot"; readonly quantity: number; readonly assetLotId: string }
  | { readonly source: "Order Line"; readonly quantity: number; readonly poLineId: string };

/** The p_sources JSON of a hold list; null leaves the default (class stock, else the only lot). */
export function sourcesJson(sources: readonly ReservationSource[] | null | undefined): Json | null {
  if (!sources || sources.length === 0) return null;
  return sources.map((s) => {
    switch (s.source) {
      case "Unit":
        return { source: s.source, quantity: 1, asset_unit_id: s.assetUnitId };
      case "Lot":
        return { source: s.source, quantity: s.quantity, asset_lot_id: s.assetLotId };
      case "Order Line":
        return { source: s.source, quantity: s.quantity, po_line_id: s.poLineId };
      default:
        return { source: s.source, quantity: s.quantity };
    }
  });
}

function allocationArgs(input: AllocationInput) {
  const t = input.target;
  return {
    p_project_id: input.projectId,
    p_engagement_id: (input.holder.engagementId ?? null) as string,
    p_roster_entry_id: (input.holder.rosterEntryId ?? null) as string,
    p_credential_category_id: (t.kind === "credential" ? t.credentialCategoryId : null) as string,
    p_asset_class_id: (t.kind === "asset" ? t.assetClassId : null) as string,
    p_fulfillment_id: (t.kind === "catering" ? t.fulfillmentId : null) as string,
    p_accommodation_block_id: (t.kind === "lodging" ? t.accommodationBlockId : null) as string,
    p_service_kind: (t.kind === "service" ? t.serviceKind : null) as AllocationServiceKind,
    p_quantity: input.quantity,
    p_needed_from: input.neededFrom,
    p_needed_to: input.neededTo,
    p_time_zone: input.timeZone,
    ...(input.note ? { p_note: input.note } : {}),
  };
}

/** Production requests an allocation for a party or a person (advancing.packet.write). */
export async function requestAllocation(db: XosClient, input: AllocationInput): Promise<Result<string>> {
  const { data, error } = await db.rpc("request_allocation", allocationArgs(input));
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** A reviewer assigns an allocation directly, Approved at once, holding asset stock from the sources. */
export async function assignAllocation(
  db: XosClient,
  input: AllocationInput & { readonly sources?: readonly ReservationSource[] | null },
): Promise<Result<string>> {
  const sources = sourcesJson(input.sources);
  const { data, error } = await db.rpc("assign_allocation", {
    ...allocationArgs(input),
    ...(sources ? { p_sources: sources } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** Approves (holding asset stock) or declines a Requested allocation; never by its requester. */
export async function decideAllocation(
  db: XosClient,
  input: {
    readonly allocationId: string;
    readonly decision: "Approved" | "Rejected";
    /** Required to decline, and to approve above the allowance with overflow at review. */
    readonly reason?: string | null;
    readonly sources?: readonly ReservationSource[] | null;
  },
): Promise<Result<null>> {
  const sources = sourcesJson(input.sources);
  const { error } = await db.rpc("decide_allocation", {
    p_allocation_id: input.allocationId,
    p_decision: input.decision,
    ...(input.reason ? { p_reason: input.reason } : {}),
    ...(sources ? { p_sources: sources } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

/** Bulk approve or decline, every rule of a single decision applying to each row. */
export async function bulkDecideAllocations(
  db: XosClient,
  ids: readonly string[],
  decision: "Approved" | "Declined",
  options: { readonly preview?: boolean; readonly reason?: string | null } = {},
): Promise<Result<BulkOutcome>> {
  return bulkUpdate(db, "advance_allocations", sameValueRows(ids, { allocation_state: decision }), options);
}

/** Replaces the holds of an Approved asset allocation before anything of it is issued. */
export async function reserveAllocation(
  db: XosClient,
  allocationId: string,
  sources: readonly ReservationSource[],
): Promise<Result<number>> {
  const { data, error } = await db.rpc("reserve_allocation", {
    p_allocation_id: allocationId,
    p_sources: sourcesJson(sources) as Json,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** One person's share of a pool in a split. */
export interface SplitPart {
  readonly rosterEntryId: string;
  readonly quantity: number;
  /** Radios or carts named for the person: their pins move with the share. */
  readonly assetUnitIds?: readonly string[];
}

export async function splitAllocation(
  db: XosClient,
  allocationId: string,
  parts: readonly SplitPart[],
): Promise<Result<string[]>> {
  const { data, error } = await db.rpc("split_allocation", {
    p_allocation_id: allocationId,
    p_parts: parts.map((p) => ({
      roster_entry_id: p.rosterEntryId,
      quantity: p.quantity,
      ...(p.assetUnitIds && p.assetUnitIds.length > 0 ? { asset_unit_ids: [...p.assetUnitIds] } : {}),
    })),
  });
  if (error) return fail(toDataError(error));
  return ok(data ?? []);
}

/** Returns part or all of a share to its pool; never more than was not issued. */
export async function unsplitAllocation(
  db: XosClient,
  childId: string,
  quantity?: number | null,
): Promise<Result<number>> {
  const { data, error } = await db.rpc("unsplit_allocation", {
    p_child_id: childId,
    ...(quantity ? { p_quantity: quantity } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(Number(data));
}

export async function withdrawAllocation(
  db: XosClient,
  allocationId: string,
  reason?: string | null,
): Promise<Result<null>> {
  const { error } = await db.rpc("withdraw_allocation", {
    p_allocation_id: allocationId,
    ...(reason ? { p_reason: reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

export async function releaseReservation(
  db: XosClient,
  reservationId: string,
  reason?: string | null,
): Promise<Result<null>> {
  const { error } = await db.rpc("release_reservation", {
    p_reservation_id: reservationId,
    ...(reason ? { p_reason: reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Issue ----------------------------------------------------------------------------------------------------------

/** The items of one issue, by kind (app.issue_allocation). */
export type IssueItem =
  | {
      readonly kind: "credential";
      readonly validFrom?: string | null;
      readonly validTo?: string | null;
      readonly rosterVehicleId?: string | null;
    }
  | { readonly kind: "unit"; readonly assetTag: string; readonly reservationId?: string | null }
  | {
      readonly kind: "lot";
      readonly assetLotId: string;
      readonly quantity: number;
      readonly reservationId?: string | null;
    }
  | {
      readonly kind: "catering";
      readonly description?: string | null;
      readonly quantity?: number | null;
    }
  | { readonly kind: "lodging"; readonly checkInOn?: string | null; readonly checkOutOn?: string | null }
  | {
      readonly kind: "travel";
      readonly travelMode: Enums["travel_mode"];
      readonly departsFrom: string;
      readonly departsAt: string;
      readonly departsTimeZone: string;
      readonly arrivesAtPlace: string;
      readonly arrivesAt?: string | null;
      readonly arrivesTimeZone: string;
      readonly operatorName?: string | null;
      readonly serviceIdentifier?: string | null;
      readonly confirmationIdentifier?: string | null;
    }
  | {
      readonly kind: "per_diem";
      readonly day: string;
      readonly amountMinor: number;
      readonly currencyCode: string;
    };

const compact = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

/** The p_items JSON of an issue, with only the keys each kind takes. */
export function issueItemsJson(items: readonly IssueItem[]): Json {
  return items.map((i) => {
    switch (i.kind) {
      case "credential":
        return compact({ valid_from: i.validFrom, valid_to: i.validTo, roster_vehicle_id: i.rosterVehicleId });
      case "unit":
        return compact({ asset_tag: i.assetTag.trim().toUpperCase(), reservation_id: i.reservationId });
      case "lot":
        return compact({ asset_lot_id: i.assetLotId, quantity: i.quantity, reservation_id: i.reservationId });
      case "catering":
        return compact({ description: i.description, quantity: i.quantity });
      case "lodging":
        return compact({ check_in_on: i.checkInOn, check_out_on: i.checkOutOn });
      case "travel":
        return compact({
          travel_mode: i.travelMode,
          departs_from: i.departsFrom,
          departs_at: i.departsAt,
          departs_time_zone: i.departsTimeZone,
          arrives_at_place: i.arrivesAtPlace,
          arrives_at: i.arrivesAt,
          arrives_time_zone: i.arrivesTimeZone,
          operator_name: i.operatorName,
          service_identifier: i.serviceIdentifier,
          confirmation_identifier: i.confirmationIdentifier,
        });
      default:
        return { day: i.day, amount_minor: i.amountMinor, currency_code: i.currencyCode };
    }
  }) as Json;
}

export interface IssueResult {
  readonly outcome: "applied" | "duplicate";
  /** Ids of the possession rows written, by table. */
  readonly possession: Readonly<Record<string, readonly string[]>>;
}

/** Hands over part or all of an Approved allocation, idempotent on the event id. */
export async function issueAllocation(
  db: XosClient,
  input: { readonly eventId: string; readonly allocationId: string; readonly items: readonly IssueItem[] },
): Promise<Result<IssueResult>> {
  const { data, error } = await db.rpc("issue_allocation", {
    p_event_id: input.eventId,
    p_allocation_id: input.allocationId,
    p_items: issueItemsJson(input.items),
  });
  if (error) return fail(toDataError(error));
  const r = (data ?? {}) as { outcome?: unknown; possession?: unknown };
  const possession: Record<string, string[]> = {};
  if (r.possession && typeof r.possession === "object") {
    for (const [table, ids] of Object.entries(r.possession as Record<string, unknown>)) {
      if (Array.isArray(ids)) possession[table] = ids.filter((x): x is string => typeof x === "string");
    }
  }
  return ok({ outcome: r.outcome === "duplicate" ? "duplicate" : "applied", possession });
}

// Catering counts -------------------------------------------------------------------------------------------------

export interface CateringCount {
  /** Null for the headcount row. */
  readonly dietaryNeed: string | null;
  /** Null when suppressed below five. */
  readonly headcount: number | null;
  readonly suppressed: boolean;
}

/** A catering's roster headcount and shared dietary needs; logged once per person counted. */
export async function cateringCounts(db: XosClient, fulfillmentId: string): Promise<Result<CateringCount[]>> {
  const { data, error } = await db.rpc("catering_counts", { p_fulfillment_id: fulfillmentId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      dietaryNeed: r.dietary_need,
      headcount: r.headcount,
      suppressed: r.suppressed === true,
    })),
  );
}

/** The org's class for radios or carts, found, marked or created (assets.asset.write). */
export async function ensureOfferingAssetClass(
  db: XosClient,
  orgId: string,
  offering: "Radios" | "Carts",
): Promise<Result<string>> {
  const { data, error } = await db.rpc("ensure_offering_asset_class", {
    p_org_id: orgId,
    p_offering: offering,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

// Parity: allowances, radio channels, availability, conflicts ---------------------------------------------------

/** What remains of an offering's cap for a pool or a person (G-174). */
export interface AllocationAllowance {
  readonly offering: OfferingKind;
  /** Null for the engagement's pool row. */
  readonly rosterEntryId: string | null;
  readonly mode: string;
  /** Null when there is no cap; remaining and beyond are null then too. */
  readonly cap: number | null;
  readonly requested: number;
  readonly approved: number;
  readonly remaining: number | null;
  readonly beyond: number | null;
}

const orNullNumber = (v: number | string | null | undefined) => (v === null || v === undefined ? null : Number(v));

export async function listAllocationAllowances(
  db: XosClient,
  engagementId: string,
): Promise<Result<AllocationAllowance[]>> {
  const { data, error } = await db.rpc("allocation_allowances", { p_engagement_id: engagementId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      offering: r.offering,
      rosterEntryId: r.roster_entry_id,
      mode: r.mode,
      cap: orNullNumber(r.cap),
      requested: num(r.requested),
      approved: num(r.approved),
      remaining: orNullNumber(r.remaining),
      beyond: orNullNumber(r.beyond),
    })),
  );
}

/** The allowance row that applies to a holder and offering: the person's own row, else the pool's. */
export function allowanceFor(
  rows: readonly AllocationAllowance[],
  offering: OfferingKind | null,
  rosterEntryId: string | null,
): AllocationAllowance | null {
  if (offering === null) return null;
  const mine = rosterEntryId
    ? rows.find((r) => r.offering === offering && r.rosterEntryId === rosterEntryId && r.cap !== null)
    : undefined;
  return mine ?? rows.find((r) => r.offering === offering && r.rosterEntryId === null) ?? null;
}

/** How far a quantity being approved goes beyond what remains; 0 within it or without a cap. */
export function beyondAllowance(allowance: AllocationAllowance | null, adding: number): number {
  if (!allowance || allowance.remaining === null) return 0;
  return Math.max(adding - allowance.remaining, 0);
}

export async function setAllocationRadioChannels(
  db: XosClient,
  allocationId: string,
  radioChannelIds: readonly string[],
): Promise<Result<null>> {
  const { error } = await db.rpc("set_allocation_radio_channels", {
    p_allocation_id: allocationId,
    p_radio_channel_ids: [...radioChannelIds],
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

export interface ProjectRadioChannel {
  readonly id: string;
  readonly channelNumber: number;
  readonly name: string;
}

/** The project's channels for the Channels picker (advancing.packet.write or safety.radio_channel.write). */
export async function listProjectRadioChannels(
  db: XosClient,
  projectId: string,
): Promise<Result<ProjectRadioChannel[]>> {
  const { data, error } = await db.rpc("project_radio_channels", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok((data ?? []).map((r) => ({ id: r.id, channelNumber: r.channel_number, name: r.name })));
}

/**
 * The default channel hint for a role (G-91): xpms.role.default_radio_channel is free canon text, matched to the
 * project's channels by number or by name. Only a hint; nothing is saved from it.
 */
export function defaultChannelHint(
  roleDefault: string | null | undefined,
  channels: readonly ProjectRadioChannel[],
): ProjectRadioChannel | null {
  const text = (roleDefault ?? "").trim().toLowerCase();
  if (!text) return null;
  const number = /\d+/.exec(text)?.[0];
  return (
    channels.find((c) => number !== undefined && c.channelNumber === Number(number)) ??
    channels.find((c) => c.name.trim().toLowerCase() === text) ??
    channels.find((c) => text.includes(c.name.trim().toLowerCase())) ??
    null
  );
}

/** One line of a project's radio hand-out. */
export interface RadioHandoutLine {
  readonly allocationId: string;
  readonly rosterEntryId: string | null;
  readonly personName: string;
  readonly partyName: string;
  readonly className: string;
  readonly quantity: number;
  readonly tagsIssued: readonly string[];
  readonly channelNumbers: readonly number[];
  readonly channelNames: readonly string[];
  readonly status: AllocationDisplayStatus;
}

export async function radioHandout(db: XosClient, projectId: string): Promise<Result<RadioHandoutLine[]>> {
  const { data, error } = await db.rpc("radio_handout", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      allocationId: r.allocation_id,
      rosterEntryId: r.roster_entry_id,
      personName: r.person_name,
      partyName: r.party_name,
      className: r.class_name,
      quantity: num(r.quantity),
      tagsIssued: r.tags_issued ?? [],
      channelNumbers: r.channel_numbers ?? [],
      channelNames: r.channel_names ?? [],
      status: isOne(ALLOCATION_DISPLAY_STATUSES, r.display_status) ? r.display_status : "Approved",
    })),
  );
}

export interface AssetClassAvailability {
  readonly serviceableUnits: number;
  readonly lotQuantity: number;
  readonly onOrderQuantity: number;
  readonly total: number;
  readonly peakReserved: number;
  readonly available: number;
  readonly unitBasis: string;
}

/** How many of a class are free over a window, in its element's unit (G-93). */
export async function getAssetClassAvailability(
  db: XosClient,
  input: { readonly assetClassId: string; readonly from: string; readonly to: string },
): Promise<Result<AssetClassAvailability>> {
  const { data, error } = await db.rpc("asset_class_availability", {
    p_asset_class_id: input.assetClassId,
    p_from: input.from,
    p_to: input.to,
  });
  if (error) return fail(toDataError(error));
  const r = (data ?? [])[0];
  if (!r) return fail({ kind: "not-found" });
  return ok({
    serviceableUnits: num(r.serviceable_units),
    lotQuantity: num(r.lot_quantity),
    onOrderQuantity: num(r.on_order_quantity),
    total: num(r.total),
    peakReserved: num(r.peak_reserved),
    available: num(r.available),
    unitBasis: r.unit_basis,
  });
}

export const RESERVATION_CONFLICTS = [
  "Unit Unavailable",
  "Class Over Reserved",
  "Lot Over Reserved",
  "Order Short",
] as const;
export type ReservationConflictKind = (typeof RESERVATION_CONFLICTS)[number];

export interface ReservationConflict {
  readonly reservationId: string;
  readonly allocationId: string;
  readonly projectId: string;
  readonly assetClassId: string;
  readonly assetUnitId: string | null;
  readonly assetLotId: string | null;
  readonly poLineId: string | null;
  readonly quantity: number;
  readonly conflict: ReservationConflictKind;
}

/** Holds that no longer fit what can supply them (app.asset_reservation_conflicts). */
export async function listReservationConflicts(
  db: XosClient,
  scope: {
    readonly orgId: string;
    readonly projectId?: string | null;
    readonly assetUnitId?: string | null;
  },
): Promise<Result<ReservationConflict[]>> {
  let query = db
    .from("asset_reservation_conflicts")
    .select("reservation_id, allocation_id, project_id, asset_class_id, asset_unit_id, asset_lot_id, po_line_id, quantity, conflict")
    .eq("org_id", scope.orgId);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  if (scope.assetUnitId) query = query.eq("asset_unit_id", scope.assetUnitId);
  const { data, error } = await query.limit(500);
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).flatMap((r) =>
      r.reservation_id === null ||
      r.allocation_id === null ||
      r.project_id === null ||
      r.asset_class_id === null ||
      !isOne(RESERVATION_CONFLICTS, r.conflict)
        ? []
        : [
            {
              reservationId: r.reservation_id,
              allocationId: r.allocation_id,
              projectId: r.project_id,
              assetClassId: r.asset_class_id,
              assetUnitId: r.asset_unit_id,
              assetLotId: r.asset_lot_id,
              poLineId: r.po_line_id,
              quantity: num(r.quantity),
              conflict: r.conflict,
            },
          ],
    ),
  );
}

/** One live hold on a unit or of its class, for the unit record's Reservations section. */
export interface UnitReservation {
  readonly id: string;
  readonly allocationId: string;
  readonly assetUnitId: string | null;
  readonly quantity: number;
  readonly neededFrom: string | null;
  readonly neededTo: string | null;
}

/** The live holds pinned to a unit and the class-stock holds of its class that have not ended. */
export async function listUnitReservations(
  db: XosClient,
  input: { readonly assetUnitId: string; readonly assetClassId: string },
): Promise<Result<UnitReservation[]>> {
  const { data, error } = await db
    .from("asset_reservations")
    .select("id, advance_allocation_id, asset_unit_id, asset_lot_id, po_line_id, quantity, advance_allocations!inner(asset_class_id, needed_during)")
    .is("released_at", null)
    .is("deleted_at", null)
    .eq("advance_allocations.asset_class_id", input.assetClassId)
    .limit(200);
  if (error) return fail(toDataError(error));
  const now = Date.now();
  return ok(
    ((data ?? []) as unknown as {
      id: string;
      advance_allocation_id: string;
      asset_unit_id: string | null;
      asset_lot_id: string | null;
      po_line_id: string | null;
      quantity: number;
      advance_allocations: { needed_during: string | null } | null;
    }[]).flatMap((r) => {
      if (r.asset_unit_id !== null && r.asset_unit_id !== input.assetUnitId) return [];
      if (r.asset_unit_id === null && (r.asset_lot_id !== null || r.po_line_id !== null)) return [];
      const w = rangeBounds(r.advance_allocations?.needed_during ?? null);
      if (w.to && Date.parse(w.to) <= now) return [];
      return [
        {
          id: r.id,
          allocationId: r.advance_allocation_id,
          assetUnitId: r.asset_unit_id,
          quantity: num(r.quantity),
          neededFrom: w.from,
          neededTo: w.to,
        },
      ];
    }),
  );
}
