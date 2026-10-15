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
  readonly source: "Mobile" | "Kiosk";
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
  /** Internal users punch as their membership; external users as their engagement (never both). */
  readonly membershipId: string | null;
  readonly engagementId: string | null;
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
  if ((ctx.membershipId === null) === (ctx.engagementId === null)) {
    throw new Error("a punch names exactly one of a membership or an engagement");
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
  // uploader fills p_monotonic_offset_ms from monotonic_at and boot_id when it sends.
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
