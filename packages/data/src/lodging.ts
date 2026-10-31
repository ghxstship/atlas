import type { XosClient } from "./client.ts";
import type { OperationsScope } from "./logistics.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Lodging fill, acts without rooms, the rooming list and lodging against the budget (B5, RRR-229, ADR 0144; migrations
 * 2945 and 2946). Every figure is derived on read; nothing is booked, paid or written to a budget line. The rooming
 * list reads project facts, so each call is logged per person returned (as the travel party is): read it on request.
 */

export interface BlockNight {
  readonly blockId: string;
  readonly projectId: string;
  readonly blockNumber: number;
  readonly title: string;
  readonly night: string;
  readonly roomsHeld: number;
  readonly assigned: number;
  readonly free: number;
  readonly releaseOn: string | null;
  readonly nightlyRateMinor: number | null;
  readonly currencyCode: string | null;
}

/** One row per live block and night it holds, in night order. */
export async function listAccommodationNights(db: XosClient, scope: OperationsScope): Promise<Result<BlockNight[]>> {
  let query = db
    .from("accommodation_block_nights")
    .select("block_id, project_id, block_number, title, night, rooms_held, assigned, free, release_on, nightly_rate_minor, currency_code")
    .eq("org_id", scope.orgId);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  const { data, error } = await query.order("night").order("block_number");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      blockId: r.block_id ?? "",
      projectId: r.project_id ?? "",
      blockNumber: r.block_number ?? 0,
      title: r.title ?? "",
      night: r.night ?? "",
      roomsHeld: r.rooms_held ?? 0,
      assigned: r.assigned ?? 0,
      free: r.free ?? 0,
      releaseOn: r.release_on,
      nightlyRateMinor: r.nightly_rate_minor,
      currencyCode: r.currency_code,
    })),
  );
}

/** Days from `today` to a release date; negative once it has passed. */
export function daysUntil(releaseOn: string, today: string): number {
  return Math.round((Date.parse(`${releaseOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** How close a release date marks a matrix cell with free rooms (ADR 0144 decision 8). */
export const RELEASE_WARNING_DAYS = 14;

export interface NightsMatrix {
  readonly nights: readonly string[];
  readonly blocks: readonly {
    readonly blockId: string;
    readonly blockNumber: number;
    readonly title: string;
    readonly releaseOn: string | null;
    /** Cells by night; null on a night the block does not hold. */
    readonly cells: readonly ({ readonly assigned: number; readonly held: number; readonly free: number; readonly releaseDue: boolean } | null)[];
  }[];
}

/**
 * The blocks-by-nights matrix: every night any block holds, in order, and per block its assigned of held on each.
 * A cell is marked releaseDue when it has free rooms and the block releases within 14 days of `today`.
 */
export function buildNightsMatrix(rows: readonly BlockNight[], today: string): NightsMatrix {
  const nights = [...new Set(rows.map((r) => r.night))].sort();
  const byBlock = new Map<string, BlockNight[]>();
  for (const r of rows) byBlock.set(r.blockId, [...(byBlock.get(r.blockId) ?? []), r]);
  const blocks = [...byBlock.values()]
    .map((list) => {
      const first = list[0] as BlockNight;
      const byNight = new Map(list.map((r) => [r.night, r]));
      const releaseSoon =
        first.releaseOn !== null &&
        daysUntil(first.releaseOn, today) >= 0 &&
        daysUntil(first.releaseOn, today) <= RELEASE_WARNING_DAYS;
      return {
        blockId: first.blockId,
        blockNumber: first.blockNumber,
        title: first.title,
        releaseOn: first.releaseOn,
        cells: nights.map((n) => {
          const r = byNight.get(n);
          return r ? { assigned: r.assigned, held: r.roomsHeld, free: r.free, releaseDue: releaseSoon && r.free > 0 } : null;
        }),
      };
    })
    .sort((a, b) => a.blockNumber - b.blockNumber);
  return { nights, blocks };
}

export interface ActWithoutRoom {
  readonly engagementId: string;
  readonly actName: string | null;
  readonly engagementState: string;
  readonly peopleCount: number;
}

export async function listActsWithoutRooms(db: XosClient, projectId: string): Promise<Result<ActWithoutRoom[]>> {
  const { data, error } = await db.rpc("acts_without_rooms", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      engagementId: r.engagement_id,
      actName: r.act_name,
      engagementState: r.engagement_state,
      peopleCount: r.people_count,
    })),
  );
}

// Rooming list ---------------------------------------------------------------------------------------------------

export type RoomingStatus = "Covered" | "Partial" | "Missing" | "No Dates";
export const ROOMING_STATUSES: readonly RoomingStatus[] = ["Missing", "Partial", "No Dates", "Covered"];

export interface SuggestedStay {
  readonly checkInOn: string;
  readonly checkOutOn: string;
  readonly source: "Credentials" | "Travel";
}

export interface AssignedStay {
  readonly assignmentId: string;
  readonly blockId: string;
  readonly blockTitle: string | null;
  readonly checkInOn: string;
  readonly checkOutOn: string;
  readonly allocationId: string | null;
}

export interface RoomingCost {
  readonly currencyCode: string | null;
  readonly nights: number;
  /** Null when a block in the currency is unpriced. */
  readonly amountMinor: number | null;
}

export interface RoomingEntry {
  readonly rosterEntryId: string;
  readonly engagementId: string;
  readonly partyName: string | null;
  readonly personId: string;
  readonly personName: string | null;
  readonly roleCode: string | null;
  readonly suggestedStays: readonly SuggestedStay[];
  readonly assignedStays: readonly AssignedStay[];
  readonly uncoveredNights: number;
  readonly status: RoomingStatus;
  readonly cost: readonly RoomingCost[];
  /** An Approved block allocation of the entry not yet issued: Assign room opens R7's Issue dialog for it. */
  readonly lodgingAllocationId: string | null;
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : null;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Obj[]) : []);

const asStatus = (v: unknown): RoomingStatus =>
  (ROOMING_STATUSES as readonly unknown[]).includes(v) ? (v as RoomingStatus) : "No Dates";

export function parseRoomingEntry(v: unknown): RoomingEntry {
  const o = (v && typeof v === "object" ? v : {}) as Obj;
  return {
    rosterEntryId: str(o["roster_entry_id"]) ?? "",
    engagementId: str(o["engagement_id"]) ?? "",
    partyName: str(o["party_name"]),
    personId: str(o["person_id"]) ?? "",
    personName: str(o["person_name"]),
    roleCode: str(o["role_code"]),
    suggestedStays: arr(o["suggested_stays"]).map((s) => ({
      checkInOn: str(s["check_in_on"]) ?? "",
      checkOutOn: str(s["check_out_on"]) ?? "",
      source: s["source"] === "Credentials" ? "Credentials" : "Travel",
    })),
    assignedStays: arr(o["assigned_stays"]).map((s) => ({
      assignmentId: str(s["assignment_id"]) ?? "",
      blockId: str(s["block_id"]) ?? "",
      blockTitle: str(s["block_title"]),
      checkInOn: str(s["check_in_on"]) ?? "",
      checkOutOn: str(s["check_out_on"]) ?? "",
      allocationId: str(s["allocation_id"]),
    })),
    uncoveredNights: num(o["uncovered_nights"]) ?? 0,
    status: asStatus(o["status"]),
    cost: arr(o["cost"]).map((c) => ({
      currencyCode: str(c["currency_code"]),
      nights: num(c["nights"]) ?? 0,
      amountMinor: num(c["amount_minor"]),
    })),
    lodgingAllocationId: str(o["lodging_allocation_id"]),
  };
}

/** The rooming list of a project. Each call writes project_facts.viewed (Travel) for every person returned. */
export async function listRoomingList(db: XosClient, projectId: string): Promise<Result<RoomingEntry[]>> {
  const { data, error } = await db.rpc("rooming_list", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok(((data ?? []) as unknown[]).map(parseRoomingEntry));
}

// Budget lines -------------------------------------------------------------------------------------------------------

export interface BudgetLineLodging {
  readonly budgetLineId: string;
  readonly currencyCode: string;
  readonly withheld: boolean;
  readonly blockCount: number | null;
  readonly otherCurrencyBlockCount: number | null;
  readonly heldRoomNights: number | null;
  readonly heldMinor: number | null;
  readonly assignedRoomNights: number | null;
  readonly assignedMinor: number | null;
}

/** Lodging drawn on a budget's lines; withheld (every figure null) for a reader without hospitality.fulfillment.read. */
export async function listBudgetLineLodging(db: XosClient, budgetId: string): Promise<Result<BudgetLineLodging[]>> {
  const { data, error } = await db
    .from("budget_line_lodging")
    .select(
      "budget_line_id, currency_code, is_lodging_withheld, block_count, other_currency_block_count, held_room_nights, held_minor, " +
        "assigned_room_nights, assigned_minor",
    )
    .eq("budget_id", budgetId);
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as {
    budget_line_id: string;
    currency_code: string;
    is_lodging_withheld: boolean | null;
    block_count: number | null;
    other_currency_block_count: number | null;
    held_room_nights: number | null;
    held_minor: number | null;
    assigned_room_nights: number | null;
    assigned_minor: number | null;
  }[];
  return ok(
    rows.map((r) => ({
      budgetLineId: r.budget_line_id,
      currencyCode: r.currency_code,
      withheld: r.is_lodging_withheld === true,
      blockCount: r.block_count,
      otherCurrencyBlockCount: r.other_currency_block_count,
      heldRoomNights: r.held_room_nights,
      heldMinor: r.held_minor,
      assignedRoomNights: r.assigned_room_nights,
      assignedMinor: r.assigned_minor,
    })),
  );
}

/** Links a block to a budget line of its own project (finance.budget.read), or unlinks it with null. */
export async function setBlockBudgetLine(db: XosClient, blockId: string, budgetLineId: string | null): Promise<Result<null>> {
  const { data, error } = await db
    .from("accommodation_blocks")
    .update({ budget_line_id: budgetLineId })
    .eq("id", blockId)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}
