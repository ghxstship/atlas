/**
 * Clock in and out (Section 4.3 item 2, Section 11.13 Clock, Section 13 Clock).
 *
 * The device keeps the punch ledger (app.clock_punches) locally and derives the clock state from it, so
 * the state is right offline and across devices once punches sync. Punches upload through
 * app.record_punch, keyed by the client UUIDv7, carrying device time, the monotonic offset and fix quality.
 * The server re-verifies the geofence, refuses a second clock-in (punch_already_in) and flags skew.
 */
import { needsReview, uuidv7, type EventTime, type MutationInput } from "@xos/sync";
import { evaluateGeofence, type Geofence, type GeofenceStatus, type LocationFix } from "./geo";

export type PunchKind = "In" | "Break Start" | "Break End" | "Out";

export interface Punch {
  readonly id: string;
  readonly punch_kind: PunchKind;
  readonly device_time: string;
  readonly project_id: string;
  readonly shift_id: string | null;
  readonly membership_id: string | null;
  readonly engagement_id: string | null;
  /** The agency staff member's roster entry (R12); absent on punches from before it. */
  readonly roster_entry_id?: string | null;
  readonly source: "Mobile" | "Kiosk" | "Supervisor";
}

export type ClockState = "out" | "on" | "break";

export interface ClockSnapshot {
  readonly state: ClockState;
  /** When the open entry started; null when clocked out. */
  readonly onSince: number | null;
  /** When the running break started; null when not on break. */
  readonly breakSince: number | null;
  /** Break minutes already taken inside the open entry. */
  readonly breakMs: number;
  readonly projectId: string | null;
  readonly shiftId: string | null;
}

/** Forgotten clock-outs close automatically at 16 hours, flagged for supervisor review (Section 4.3). */
export const AUTO_CLOSE_MS = 16 * 60 * 60_000;

const time = (p: Punch) => Date.parse(p.device_time);

/** Replays the person's punches into the current clock state. Punches are sorted by device time. */
export function deriveClock(punches: readonly Punch[], nowMs: number): ClockSnapshot {
  const ordered = [...punches].sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));
  let snapshot: ClockSnapshot = {
    state: "out",
    onSince: null,
    breakSince: null,
    breakMs: 0,
    projectId: null,
    shiftId: null,
  };
  for (const punch of ordered) {
    const at = time(punch);
    if (
      snapshot.state !== "out" &&
      snapshot.onSince !== null &&
      at - snapshot.onSince >= AUTO_CLOSE_MS
    ) {
      snapshot = { ...snapshot, state: "out", onSince: null, breakSince: null, breakMs: 0 };
    }
    switch (punch.punch_kind) {
      case "In":
        if (snapshot.state === "out") {
          snapshot = {
            state: "on",
            onSince: at,
            breakSince: null,
            breakMs: 0,
            projectId: punch.project_id,
            shiftId: punch.shift_id,
          };
        }
        break;
      case "Break Start":
        if (snapshot.state === "on") snapshot = { ...snapshot, state: "break", breakSince: at };
        break;
      case "Break End":
        if (snapshot.state === "break" && snapshot.breakSince !== null) {
          snapshot = {
            ...snapshot,
            state: "on",
            breakMs: snapshot.breakMs + (at - snapshot.breakSince),
            breakSince: null,
          };
        }
        break;
      case "Out":
        snapshot = {
          state: "out",
          onSince: null,
          breakSince: null,
          breakMs: 0,
          projectId: null,
          shiftId: null,
        };
        break;
    }
  }
  if (
    snapshot.state !== "out" &&
    snapshot.onSince !== null &&
    nowMs - snapshot.onSince >= AUTO_CLOSE_MS
  ) {
    return {
      state: "out",
      onSince: null,
      breakSince: null,
      breakMs: 0,
      projectId: null,
      shiftId: null,
    };
  }
  return snapshot;
}

/** True when the newest open entry ran past 16 hours and the server will close it for review. */
export function forgottenClockOut(punches: readonly Punch[], nowMs: number): boolean {
  const ordered = [...punches].sort((a, b) => time(a) - time(b));
  let openSince: number | null = null;
  for (const p of ordered) {
    if (p.punch_kind === "In" && openSince === null) openSince = time(p);
    else if (p.punch_kind === "Out") openSince = null;
    else if (openSince !== null && time(p) - openSince >= AUTO_CLOSE_MS) openSince = null;
  }
  return openSince !== null && nowMs - openSince >= AUTO_CLOSE_MS;
}

/**
 * Whether the clock samples location precisely (samplingPlan's "punching"): while a punch is under way,
 * and while the clock is open in front of a person who is clocked out. Away from a call the battery plan
 * turns sampling off, so without the open clock a person who arrives early, or works without a rostered
 * shift, never gets a fix and the clock refuses with location-unknown for good.
 */
export function needsPreciseFix(clockOpen: boolean, state: ClockState, punching: boolean): boolean {
  return punching || (clockOpen && state === "out");
}

/** The one primary action the Today screen leads with (Section 11.13). */
export function primaryPunch(state: ClockState): PunchKind {
  if (state === "out") return "In";
  if (state === "break") return "Break End";
  return "Out";
}

/** Secondary actions, shown beside the primary one. */
export function secondaryPunches(state: ClockState): PunchKind[] {
  if (state === "on") return ["Break Start"];
  if (state === "break") return ["Out"];
  return [];
}

export type PunchRefusal =
  /** Already clocked in, possibly on another device (Section 4.3 double clock-in protection). */
  | "already-in"
  | "not-clocked-in"
  | "not-on-break"
  | "already-on-break"
  /** Outside every geofence of the project and the org requires on-site punches. */
  | "outside-geofence"
  /** The location is unknown and the org requires on-site punches. */
  | "location-unknown"
  /** No shift today on this project and the org requires a rostered shift. */
  | "not-rostered";

export interface PunchPolicy {
  /** Org setting: punches must happen inside a geofence. */
  readonly requireGeofence: boolean;
  /** Org setting: a punch needs a shift on the project today. */
  readonly requireShift: boolean;
}

export function checkPunch(
  kind: PunchKind,
  snapshot: ClockSnapshot,
  geofence: GeofenceStatus,
  policy: PunchPolicy,
  hasShift: boolean,
): PunchRefusal | null {
  switch (kind) {
    case "In":
      if (snapshot.state !== "out") return "already-in";
      if (policy.requireShift && !hasShift) return "not-rostered";
      break;
    case "Break Start":
      if (snapshot.state === "break") return "already-on-break";
      if (snapshot.state !== "on") return "not-clocked-in";
      return null;
    case "Break End":
      if (snapshot.state !== "break") return "not-on-break";
      return null;
    case "Out":
      if (snapshot.state === "out") return "not-clocked-in";
      return null;
  }
  if (policy.requireGeofence) {
    if (geofence.kind === "outside") return "outside-geofence";
    if (geofence.kind === "unknown") return "location-unknown";
  }
  return null;
}

/** Formats an elapsed duration as H:MM:SS for the shift timer. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** Worked time of the open entry: since clock-in, minus breaks, minus the running break. */
export function workedMs(snapshot: ClockSnapshot, nowMs: number): number {
  if (snapshot.onSince === null) return 0;
  const runningBreak = snapshot.breakSince === null ? 0 : nowMs - snapshot.breakSince;
  return nowMs - snapshot.onSince - snapshot.breakMs - runningBreak;
}

export interface PunchContext {
  readonly projectId: string;
  readonly shiftId: string | null;
  /**
   * Internal users punch as their membership; external users as their engagement; agency staff as their roster
   * entry, on its shift (R12). Exactly one of the three.
   */
  readonly membershipId: string | null;
  readonly engagementId: string | null;
  readonly rosterEntryId?: string | null;
  readonly source: "Mobile" | "Kiosk";
  readonly kioskDeviceId?: string | null;
  readonly photoUri?: string | null;
}

/**
 * Builds the queued punch. The optimistic row lands in clock_punches immediately, so the Clock button
 * flips state within 100 ms even offline (Section 11.10 item 9).
 */
export function buildPunch(
  kind: PunchKind,
  ctx: PunchContext,
  event: EventTime,
  fix: LocationFix | null,
  geofences: readonly Geofence[],
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const rosterEntryId = ctx.rosterEntryId ?? null;
  const workers = [ctx.membershipId, ctx.engagementId, rosterEntryId].filter((w) => w !== null);
  if (workers.length !== 1) {
    throw new Error("a punch names exactly one of a membership, an engagement or a roster entry");
  }
  // app.record_punch finds an agency staff member's roster entry through their shift (R12).
  if (rosterEntryId !== null && ctx.shiftId === null) {
    throw new Error("a roster punch names the roster entry's shift");
  }
  const id = newId(nowMs);
  const status = evaluateGeofence(fix, geofences, nowMs);
  const geofenceId = status.kind === "inside" ? status.geofence.id : null;
  const row: Punch & Record<string, unknown> = {
    id,
    punch_kind: kind,
    device_time: event.deviceAt,
    project_id: ctx.projectId,
    shift_id: ctx.shiftId,
    membership_id: ctx.membershipId,
    engagement_id: ctx.engagementId,
    roster_entry_id: rosterEntryId,
    source: ctx.source,
    latitude: fix?.latitude ?? null,
    longitude: fix?.longitude ?? null,
    accuracy_m: fix?.accuracyM ?? null,
    geofence_id: geofenceId,
    kiosk_device_id: ctx.kioskDeviceId ?? null,
    photo_uri: ctx.photoUri ?? null,
    device_geofence_status: status.kind,
    device_needs_review: needsReview(event),
  };
  // Named arguments of app.record_punch. The monotonic offset is the punch's age at upload, so the
  // uploader fills p_monotonic_offset_ms from monotonic_at and boot_id when it sends. A roster punch sends only
  // the shift, with no membership and no engagement.
  const args = {
    p_punch_id: id,
    p_project_id: ctx.projectId,
    p_punch_kind: kind,
    p_device_time: event.deviceAt,
    p_shift_id: ctx.shiftId,
    p_latitude: fix?.latitude ?? null,
    p_longitude: fix?.longitude ?? null,
    p_accuracy_m: fix?.accuracyM ?? null,
    p_geofence_id: geofenceId,
    p_source: ctx.source,
    p_kiosk_device_id: ctx.kioskDeviceId ?? null,
    p_photo_uri: ctx.photoUri ?? null,
    p_membership_id: ctx.membershipId,
    p_engagement_id: ctx.engagementId,
    monotonic_at: event.monotonicAt,
    boot_id: event.bootId,
  };
  return {
    op: "rpc",
    target: "app.record_punch",
    table: "clock_punches",
    rowId: id,
    payload: args,
    policy: "append",
    optimistic: row,
  };
}

/** One worker a supervisor punches in or out: the shift they hold today, and their name for the screen. */
export interface TeamMember {
  readonly shiftId: string;
  readonly name: string;
}

/** What the server answered for one worker of a team punch (app.record_supervisor_punches). */
export type TeamPunchOutcome = "pending" | "applied" | "duplicate" | "refused";

/** A team punch as the device keeps it: the batch, and each worker's punch id, shift and outcome. */
export interface TeamPunchBatch {
  readonly id: string;
  readonly punch_kind: PunchKind;
  readonly project_id: string;
  readonly device_time: string;
  readonly results: readonly {
    readonly punch_id: string;
    readonly shift_id: string;
    readonly outcome: TeamPunchOutcome;
    readonly code: string | null;
  }[];
}

/** The device table that holds team punches and, once uploaded, the server's answer for each worker. */
export const TEAM_PUNCH_TABLE = "supervisor_punch_batches";

/** The most a team punch holds, as the server refuses more (supervisor_punch_batch). */
export const TEAM_PUNCH_LIMIT = 100;

/**
 * Builds a supervisor's team punch (R12, G-126): one queued mutation for the whole selection, so it replays
 * offline as one call to app.record_supervisor_punches. The batch id and one punch id per worker are minted
 * now, at capture, with the device time and the monotonic age, so a replay after reconnecting is the same
 * punch and the server answers duplicate instead of punching twice. The optimistic row shows every worker
 * as pending until the server's answer, with an outcome and refusal code each, replaces it.
 */
export function buildSupervisorPunchBatch(
  kind: PunchKind,
  projectId: string,
  team: readonly TeamMember[],
  event: EventTime,
  fix: LocationFix | null,
  geofences: readonly Geofence[],
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const shifts = [...new Set(team.map((m) => m.shiftId))];
  if (shifts.length === 0) throw new Error("a team punch names at least one worker");
  if (shifts.length > TEAM_PUNCH_LIMIT)
    throw new Error(`a team punch names at most ${TEAM_PUNCH_LIMIT} workers`);
  const batchId = newId(nowMs);
  const punches = shifts.map((shiftId) => ({ punch_id: newId(nowMs), shift_id: shiftId }));
  const status = evaluateGeofence(fix, geofences, nowMs);
  const optimistic: TeamPunchBatch & Record<string, unknown> = {
    id: batchId,
    punch_kind: kind,
    project_id: projectId,
    device_time: event.deviceAt,
    results: punches.map((p) => ({ ...p, outcome: "pending", code: null })),
  };
  return {
    op: "rpc",
    target: "app.record_supervisor_punches",
    table: TEAM_PUNCH_TABLE,
    rowId: batchId,
    payload: {
      p_batch_id: batchId,
      p_project_id: projectId,
      p_punch_kind: kind,
      p_device_time: event.deviceAt,
      p_punches: punches,
      p_latitude: fix?.latitude ?? null,
      p_longitude: fix?.longitude ?? null,
      p_accuracy_m: fix?.accuracyM ?? null,
      p_geofence_id: status.kind === "inside" ? status.geofence.id : null,
      monotonic_at: event.monotonicAt,
      boot_id: event.bootId,
    },
    policy: "append",
    optimistic,
  };
}

/**
 * Whether each selected worker is clocked in now, from the newest team punch that reached them: an In that
 * applied (or was already recorded) puts them in, an Out takes them out. Their own punches are theirs to read
 * in their own app; a supervisor sees what they punched.
 */
export function teamClockState(
  batches: readonly TeamPunchBatch[],
): ReadonlyMap<string, "in" | "out"> {
  const state = new Map<string, "in" | "out">();
  const ordered = [...batches].sort(
    (a, b) => Date.parse(a.device_time) - Date.parse(b.device_time) || a.id.localeCompare(b.id),
  );
  for (const batch of ordered) {
    for (const r of batch.results) {
      if (r.outcome === "refused") continue;
      state.set(r.shift_id, batch.punch_kind === "Out" ? "out" : "in");
    }
  }
  return state;
}

/** The one primary team action (Section 11.13): Clock in while nobody selected is in, else Clock out. */
export function primaryTeamPunch(
  selected: readonly string[],
  state: ReadonlyMap<string, "in" | "out">,
): "In" | "Out" {
  return selected.some((shiftId) => state.get(shiftId) === "in") ? "Out" : "In";
}

/** A shift on the supervisor's team board, as the device holds it (internal sync or api_external.shifts). */
export interface TeamShiftRow {
  readonly [column: string]: unknown;
  readonly id: string;
  readonly project_id: string;
  readonly membership_id?: string | null;
  readonly engagement_id?: string | null;
  readonly roster_entry_id?: string | null;
  readonly holder_name?: string | null;
  readonly is_agency_slot?: boolean | null;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly shift_state?: string;
  readonly time_zone?: string;
  readonly job_title?: string | null;
}

/** Shifts on today's board: someone holds them, they are live, and they have not ended long ago or start tomorrow. */
export function teamShifts(
  rows: readonly TeamShiftRow[],
  projectId: string | null,
  nowMs: number,
): TeamShiftRow[] {
  return rows
    .filter(
      (s) =>
        s.project_id === projectId &&
        s.shift_state !== "Canceled" &&
        s.shift_state !== "Draft" &&
        s.is_agency_slot !== true &&
        (Boolean(s.membership_id) || Boolean(s.engagement_id) || Boolean(s.roster_entry_id)) &&
        Date.parse(s.ends_at) > nowMs - 6 * 3600_000 &&
        Date.parse(s.starts_at) < nowMs + 18 * 3600_000,
    )
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id));
}
