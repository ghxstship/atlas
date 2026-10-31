import type { Database, XosClient } from "./client.ts";
import type { OperationsScope } from "./logistics.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Green room and dressing room bookings (B5, RRR-229, ADR 0144; migration 2943). Reads come from
 * app.space_booking_board, which groups overlapping Shared bookings, compares the peak party with the space's capacity
 * and flags a set that moved, all on read. Writes need hospitality.fulfillment.write. The database refuses an Exclusive
 * booking over any booking and a Shared one over an Exclusive one (space_booking_overlap), a space of another venue
 * (space_booking_venue) or a deleted one (space_booking_space), and a set time of another engagement
 * (space_booking_set_engagement).
 */

type Tables = Database["app"]["Tables"];
type Derived<T> = Omit<T, "org_id">;

export type SpaceBookingPurpose = Database["app"]["Enums"]["space_booking_purpose"];
export const SPACE_BOOKING_PURPOSES: readonly SpaceBookingPurpose[] = [
  "Green Room",
  "Dressing Room",
  "Production Office",
  "Hospitality Suite",
  "Other",
];
export type SpaceBookingMode = Database["app"]["Enums"]["space_booking_mode"];
export const SPACE_BOOKING_MODES: readonly SpaceBookingMode[] = ["Exclusive", "Shared"];

export interface SpaceBooking {
  readonly id: string;
  readonly projectId: string;
  readonly spaceId: string;
  readonly spaceName: string | null;
  readonly spaceCapacity: number | null;
  readonly venueName: string | null;
  readonly engagementId: string | null;
  readonly engagementCueId: string | null;
  readonly actName: string | null;
  readonly purpose: SpaceBookingPurpose;
  readonly mode: SpaceBookingMode;
  readonly partySize: number | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly setLabel: string | null;
  readonly setPlannedAt: string | null;
  readonly setEndsAt: string | null;
  readonly setMoved: boolean;
  /** First booking of the cluster of overlapping bookings this one belongs to; null when it overlaps none. */
  readonly conflictGroup: string | null;
  readonly groupSize: number;
  readonly groupPartyTotal: number;
  readonly groupPeakParty: number;
  /** Null when the space has no measured capacity. */
  readonly overCapacity: boolean | null;
  readonly notes: string | null;
}

interface BoardRow {
  id: string;
  project_id: string;
  space_id: string;
  space_name: string | null;
  space_capacity: number | null;
  venue_name: string | null;
  engagement_id: string | null;
  engagement_cue_id: string | null;
  act_name: string | null;
  purpose: SpaceBookingPurpose;
  booking_mode: SpaceBookingMode;
  party_size: number | null;
  starts_at: string;
  ends_at: string;
  set_label: string | null;
  set_planned_at: string | null;
  set_ends_at: string | null;
  set_moved: boolean | null;
  conflict_group: string | null;
  group_size: number | null;
  group_party_total: number | null;
  group_peak_party: number | null;
  over_capacity: boolean | null;
  notes: string | null;
}

const BOARD_COLUMNS =
  "id, project_id, space_id, space_name, space_capacity, venue_name, engagement_id, engagement_cue_id, act_name, purpose, " +
  "booking_mode, party_size, starts_at, ends_at, set_label, set_planned_at, set_ends_at, set_moved, conflict_group, group_size, " +
  "group_party_total, group_peak_party, over_capacity, notes";

export function toSpaceBooking(row: BoardRow): SpaceBooking {
  return {
    id: row.id,
    projectId: row.project_id,
    spaceId: row.space_id,
    spaceName: row.space_name,
    spaceCapacity: row.space_capacity,
    venueName: row.venue_name,
    engagementId: row.engagement_id,
    engagementCueId: row.engagement_cue_id,
    actName: row.act_name,
    purpose: row.purpose,
    mode: row.booking_mode,
    partySize: row.party_size,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    setLabel: row.set_label,
    setPlannedAt: row.set_planned_at,
    setEndsAt: row.set_ends_at,
    setMoved: row.set_moved === true,
    conflictGroup: row.conflict_group,
    groupSize: row.group_size ?? 1,
    groupPartyTotal: row.group_party_total ?? 0,
    groupPeakParty: row.group_peak_party ?? 0,
    overCapacity: row.over_capacity,
    notes: row.notes,
  };
}

/** Live bookings in start order. */
export async function listSpaceBookings(
  db: XosClient,
  scope: OperationsScope,
): Promise<Result<SpaceBooking[]>> {
  let query = db.from("space_booking_board").select(BOARD_COLUMNS).eq("org_id", scope.orgId);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  const { data, error } = await query.order("starts_at").order("space_name");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as BoardRow[]).map(toSpaceBooking));
}

/** Clusters of overlapping bookings, the bookings of each in start order: the conflicts strip. */
export function conflictGroups(bookings: readonly SpaceBooking[]): SpaceBooking[][] {
  const groups = new Map<string, SpaceBooking[]>();
  for (const b of bookings) {
    if (!b.conflictGroup) continue;
    const list = groups.get(b.conflictGroup) ?? [];
    list.push(b);
    groups.set(b.conflictGroup, list);
  }
  return [...groups.values()].map((g) =>
    [...g].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
  );
}

export interface SpaceBookingInput {
  readonly spaceId: string;
  readonly engagementId: string | null;
  readonly engagementCueId: string | null;
  readonly purpose: SpaceBookingPurpose;
  readonly mode: SpaceBookingMode;
  readonly partySize: number | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly notes: string | null;
}

function bookingColumns(input: SpaceBookingInput) {
  return {
    space_id: input.spaceId,
    engagement_id: input.engagementId,
    engagement_cue_id: input.engagementCueId,
    purpose: input.purpose,
    booking_mode: input.mode,
    party_size: input.partySize,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    notes: input.notes,
  };
}

/** Minutes before a set a room opens and after it ends that it stays booked, as form defaults. */
export const SET_LEAD_MINUTES = 90;
export const SET_TAIL_MINUTES = 60;

/**
 * The in and out a booking for a set time starts from: 90 minutes before the planned start and 60 minutes after the
 * planned end (start plus duration). Form defaults only; the planner edits them. Null without a planned time.
 */
export function setTimeWindow(
  plannedAt: string | null,
  durationMinutes: number | null,
): { startsAt: string; endsAt: string } | null {
  if (!plannedAt) return null;
  const start = new Date(plannedAt).getTime();
  if (Number.isNaN(start)) return null;
  const end = start + (durationMinutes ?? 0) * 60_000;
  return {
    startsAt: new Date(start - SET_LEAD_MINUTES * 60_000).toISOString(),
    endsAt: new Date(end + SET_TAIL_MINUTES * 60_000).toISOString(),
  };
}

export async function createSpaceBooking(
  db: XosClient,
  projectId: string,
  input: SpaceBookingInput,
): Promise<Result<{ id: string }>> {
  const row: Derived<Tables["space_bookings"]["Insert"]> = {
    project_id: projectId,
    ...bookingColumns(input),
  };
  const { data, error } = await db
    .from("space_bookings")
    .insert(row as Tables["space_bookings"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  const created = data?.[0];
  return created ? ok(created) : fail({ kind: "not-found" });
}

export async function updateSpaceBooking(
  db: XosClient,
  id: string,
  input: SpaceBookingInput,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("space_bookings")
    .update(bookingColumns(input))
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** Cancels a booking, or restores it with `deleted` false; the guard checks the space again. */
export async function cancelSpaceBooking(
  db: XosClient,
  id: string,
  deleted = true,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("space_bookings")
    .update({ deleted_at: deleted ? new Date().toISOString() : null })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export interface SetTimeOption {
  /** The engagement cue (app.engagement_cues) a booking names. */
  readonly id: string;
  readonly engagementId: string;
  readonly label: string;
  readonly plannedAt: string | null;
  readonly durationMinutes: number | null;
}

/** "01:15:00" or "75 minutes" style intervals as minutes; null when unknown. */
export function intervalMinutes(raw: string | null): number | null {
  if (!raw) return null;
  const clock = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (clock)
    return Number(clock[1]) * 60 + Number(clock[2]) + Math.round(Number(clock[3] ?? 0) / 60);
  const minutes = /^(\d+) min/.exec(raw.trim());
  return minutes ? Number(minutes[1]) : null;
}

/** Artist set times of a project the reader may read (show.run_of_show.read), in planned order. Cues carry their
 * project (0412), so the engagement itself, read with opportunities.engagement.read, is never needed. */
export async function listProjectSetTimes(
  db: XosClient,
  projectId: string,
): Promise<Result<SetTimeOption[]>> {
  const { data, error } = await db
    .from("engagement_cues")
    .select(
      "id, engagement_id, cue:cues!engagement_cues_cue_id_fkey!inner(project_id, label, planned_at, duration, deleted_at)",
    )
    .is("deleted_at", null)
    .eq("cue.project_id", projectId);
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as {
    id: string;
    engagement_id: string;
    cue: {
      project_id: string;
      label: string;
      planned_at: string | null;
      duration: string | null;
      deleted_at: string | null;
    } | null;
  }[];
  return ok(
    rows
      .filter((r) => r.cue?.project_id === projectId && r.cue.deleted_at === null)
      .map((r) => ({
        id: r.id,
        engagementId: r.engagement_id,
        label: r.cue?.label ?? "",
        plannedAt: r.cue?.planned_at ?? null,
        durationMinutes: intervalMinutes(r.cue?.duration ?? null),
      }))
      .sort((a, b) => (a.plannedAt ?? "").localeCompare(b.plannedAt ?? "")),
  );
}
