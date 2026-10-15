import type { Database, XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";
import {
  ENGAGEMENT_EMBED,
  landed,
  MEMBERSHIP_EMBED,
  toTransitions,
  toWorker,
  type EngagementRow,
  type TransitionEntry,
  type WorkerRef,
} from "./shared.ts";

/**
 * Shifts (app.shifts, migrations 0340 and 0460): one person or an open slot, in one canon role, for
 * one block of time on a project. A shift is drafted, published, accepted by its person or claimed
 * from the open shifts, and can be canceled. Compass (A17) reads `listShifts` for a person and
 * calls `acceptShift` and `claimOpenShift`.
 */

export type ShiftState = Database["app"]["Enums"]["shift_state"];
export const SHIFT_STATES: readonly ShiftState[] = ["Draft", "Published", "Accepted", "Canceled"];

export interface Shift {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  /** The member or external crew on the shift; null for an open shift. */
  readonly member: WorkerRef | null;
  readonly roleCode: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly state: ShiftState;
  readonly recordId: string | null;
  readonly scopeNodeId: string | null;
  readonly createdAt: string;
}

export interface ShiftFilter {
  readonly orgId: string;
  readonly projectId?: string;
  readonly membershipId?: string;
  /** Shifts that end after this instant. */
  readonly from?: string;
  /** Shifts that start before this instant. */
  readonly to?: string;
  /** Only open shifts (no person assigned). */
  readonly open?: boolean;
  readonly states?: readonly ShiftState[];
  readonly limit?: number;
}

const SHIFT_SELECT = `id, project_id, membership_id, role_code, starts_at, ends_at, time_zone, shift_state, record_id, scope_node_id, created_at, project:projects!shifts_project_id_fkey(project_key, name), membership:memberships!shifts_membership_id_fkey(${MEMBERSHIP_EMBED}), engagement_id, engagement:engagements!shifts_engagement_id_fkey(${ENGAGEMENT_EMBED})`;

interface ShiftRow {
  id: string;
  project_id: string;
  membership_id: string | null;
  role_code: string | null;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  shift_state: ShiftState;
  record_id: string | null;
  scope_node_id: string | null;
  created_at: string;
  project: { project_key: string; name: string } | null;
  membership: {
    id: string;
    person_id: string;
    person: { full_name: string | null } | null;
  } | null;
  engagement_id: string | null;
  engagement: EngagementRow | null;
}

function toShift(row: ShiftRow): Shift {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    projectName: row.project?.name ?? "",
    member:
      row.membership_id || row.engagement_id
        ? toWorker(row.membership, row.membership_id, row.engagement, row.engagement_id)
        : null,
    roleCode: row.role_code,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timeZone: row.time_zone,
    state: row.shift_state,
    recordId: row.record_id,
    scopeNodeId: row.scope_node_id,
    createdAt: row.created_at,
  };
}

/** Shifts the caller may read, by start time. Soft-deleted shifts are in Trash and never listed. */
export async function listShifts(db: XosClient, filter: ShiftFilter): Promise<Result<Shift[]>> {
  let query = db
    .from("shifts")
    .select(SHIFT_SELECT)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null)
    .order("starts_at", { ascending: true })
    .limit(Math.min(filter.limit ?? 500, 2000));
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.membershipId) query = query.eq("membership_id", filter.membershipId);
  if (filter.open) query = query.is("membership_id", null);
  if (filter.from) query = query.gt("ends_at", filter.from);
  if (filter.to) query = query.lt("starts_at", filter.to);
  if (filter.states && filter.states.length > 0)
    query = query.in("shift_state", [...filter.states]);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as unknown as ShiftRow[]).map(toShift));
}

export interface ShiftDetail extends Shift {
  readonly transitions: readonly TransitionEntry[];
}

/** One shift with its state ledger, or not-found. */
export async function getShift(db: XosClient, id: string): Promise<Result<ShiftDetail>> {
  const { data, error } = await db
    .from("shifts")
    .select(SHIFT_SELECT)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const ledger = await db
    .from("shift_state_transitions")
    .select("id, from_state, to_state, reason, created_at, created_by")
    .eq("shift_id", id);
  if (ledger.error) return fail(toDataError(ledger.error));
  return ok({ ...toShift(data as unknown as ShiftRow), transitions: toTransitions(ledger.data) });
}

export interface ShiftInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly roleCode: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  /** Null plans an open shift. */
  readonly membershipId: string | null;
  readonly scopeNodeId?: string | null;
}

/** Plans a Draft shift. The database refuses an end before the start and a zone that is not IANA. */
export async function createShift(
  db: XosClient,
  input: ShiftInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("shifts")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      role_code: input.roleCode,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      time_zone: input.timeZone,
      membership_id: input.membershipId,
      scope_node_id: input.scopeNodeId ?? null,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export type ShiftPatch = Partial<
  Pick<ShiftInput, "roleCode" | "startsAt" | "endsAt" | "timeZone" | "membershipId">
>;

/** Edits a shift's times, role or person. Reassigning an Accepted shift returns it to Published. */
export async function updateShift(
  db: XosClient,
  id: string,
  patch: ShiftPatch,
): Promise<Result<null>> {
  const update: Database["app"]["Tables"]["shifts"]["Update"] = {};
  if (patch.roleCode !== undefined) update.role_code = patch.roleCode;
  if (patch.startsAt !== undefined) update.starts_at = patch.startsAt;
  if (patch.endsAt !== undefined) update.ends_at = patch.endsAt;
  if (patch.timeZone !== undefined) update.time_zone = patch.timeZone;
  if (patch.membershipId !== undefined) update.membership_id = patch.membershipId;
  const { data, error } = await db
    .from("shifts")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/** Moves a shift to Trash (soft delete); it can be restored within the retention period. */
export async function trashShift(db: XosClient, id: string, at: Date = new Date()) {
  const { data, error } = await db
    .from("shifts")
    .update({ deleted_at: at.toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/** Restores a shift from Trash. */
export async function restoreShift(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("shifts")
    .update({ deleted_at: null })
    .eq("id", id)
    .not("deleted_at", "is", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/** Publishes, returns to draft or cancels a shift with compare-and-set (app.transition_shift). */
export async function transitionShift(
  db: XosClient,
  id: string,
  expected: ShiftState,
  next: ShiftState,
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("transition_shift", {
    p_shift_id: id,
    p_expected: expected,
    p_next: next,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

/** Publishes drafted shifts, all or none (app.publish_shifts). */
export async function publishShifts(
  db: XosClient,
  ids: readonly string[],
  reason: string,
): Promise<Result<{ published: number }>> {
  const { data, error } = await db.rpc("publish_shifts", {
    p_shift_ids: [...ids],
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ published: data });
}

/** The person assigned accepts a Published shift (app.accept_shift). */
export async function acceptShift(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("accept_shift", { p_shift_id: id, p_reason: reason });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

/** A member claims a Published open shift (app.claim_open_shift). */
export async function claimOpenShift(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("claim_open_shift", { p_shift_id: id, p_reason: reason });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

/** Where a shift sits in time, for display: upcoming, in progress or over. */
export type ShiftTiming = "upcoming" | "in-progress" | "over";

export function shiftTiming(shift: Pick<Shift, "startsAt" | "endsAt">, now: Date): ShiftTiming {
  const t = now.getTime();
  if (t < Date.parse(shift.startsAt)) return "upcoming";
  if (t < Date.parse(shift.endsAt)) return "in-progress";
  return "over";
}

/** Minutes of a shift. */
export function shiftMinutes(shift: Pick<Shift, "startsAt" | "endsAt">): number {
  return Math.round((Date.parse(shift.endsAt) - Date.parse(shift.startsAt)) / 60_000);
}

/**
 * Pairs of live shifts of one person that overlap, for the double booking warning (the database
 * refuses overlapping time entries and overlapping claims; planners see overlaps before that).
 */
export function doubleBookings(shifts: readonly Shift[]): Array<[Shift, Shift]> {
  const live = shifts
    .filter((s) => s.member !== null && s.state !== "Canceled")
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const pairs: Array<[Shift, Shift]> = [];
  for (let i = 0; i < live.length; i += 1) {
    const a = live[i] as Shift;
    for (let j = i + 1; j < live.length; j += 1) {
      const b = live[j] as Shift;
      if (Date.parse(b.startsAt) >= Date.parse(a.endsAt)) break;
      if (a.member?.personId !== null && a.member?.personId === b.member?.personId) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

/** Minutes each person is scheduled within a set of shifts, by person id. */
export function scheduledMinutesByPerson(shifts: readonly Shift[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const s of shifts) {
    const person = s.member?.personId;
    if (!person || s.state === "Canceled") continue;
    totals.set(person, (totals.get(person) ?? 0) + shiftMinutes(s));
  }
  return totals;
}
