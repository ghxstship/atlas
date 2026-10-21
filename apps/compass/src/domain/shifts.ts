/**
 * Schedule (Section 4.3 item 3): my shifts by day, open shifts to claim, accept. No self-approval:
 * accepting a shift assigned to me and claiming an open one are the person's own acts; approvals stay with
 * supervisors in Atlas.
 */
import type { MutationInput } from "@xos/sync";

export interface ShiftRow {
  readonly id: string;
  readonly project_id: string;
  readonly membership_id?: string | null;
  readonly engagement_id?: string | null;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly time_zone?: string;
  readonly shift_state?: string;
  readonly role_code?: string | null;
  readonly job_title?: string | null;
}

export interface ShiftDay {
  readonly day: string;
  readonly shifts: readonly ShiftRow[];
}

/** Upcoming shifts grouped by local day, soonest first. Shifts that ended are left out. */
export function groupByDay(
  shifts: readonly ShiftRow[],
  nowMs: number,
  dayOf: (iso: string, tz?: string) => string,
): ShiftDay[] {
  const days = new Map<string, ShiftRow[]>();
  for (const s of [...shifts].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))) {
    if (Date.parse(s.ends_at) < nowMs || s.shift_state === "Draft") continue;
    const key = dayOf(s.starts_at, s.time_zone);
    days.set(key, [...(days.get(key) ?? []), s]);
  }
  return [...days].map(([day, list]) => ({ day, shifts: list }));
}

export function isOpenShift(s: ShiftRow): boolean {
  return (
    (s.membership_id ?? null) === null &&
    (s.engagement_id ?? null) === null &&
    s.shift_state === "Published"
  );
}

/**
 * A shift assigned to this person: through their membership, or one of their operational engagements.
 * Open shifts and colleagues' shifts are not "mine", so Today and My shifts never label them "Waiting
 * for you".
 */
export function isMine(
  s: ShiftRow,
  me: { readonly membershipId: string | null; readonly engagementIds: readonly string[] },
): boolean {
  return (
    (me.membershipId !== null && s.membership_id === me.membershipId) ||
    (typeof s.engagement_id === "string" && me.engagementIds.includes(s.engagement_id))
  );
}

export type ShiftAction = "accept" | "claim" | null;

/**
 * Journey 66: the org's claiming rule as the device can check it before queuing (claim_open_shift,
 * 0460, decides for good): a person never holds two overlapping shifts. Returns the shift already held
 * that overlaps, or null.
 */
export function claimConflict(open: ShiftRow, mine: readonly ShiftRow[]): ShiftRow | null {
  const start = Date.parse(open.starts_at);
  const end = Date.parse(open.ends_at);
  return (
    mine.find(
      (s) =>
        s.id !== open.id &&
        s.shift_state !== "Canceled" &&
        Date.parse(s.starts_at) < end &&
        Date.parse(s.ends_at) > start,
    ) ?? null
  );
}

export function actionFor(
  s: ShiftRow,
  me: { readonly membershipId: string | null; readonly engagementIds: readonly string[] },
): ShiftAction {
  if (s.shift_state !== "Published") return null;
  if (isOpenShift(s)) return me.membershipId ? "claim" : null;
  const mine =
    (me.membershipId !== null && s.membership_id === me.membershipId) ||
    (typeof s.engagement_id === "string" && me.engagementIds.includes(s.engagement_id));
  return mine ? "accept" : null;
}

/**
 * Accept or claim. Internal acts replay through app.apply_sync_mutation (accept_shift and claim_open_shift
 * are allowlisted); an engaged external person accepts through app.accept_engaged_shift.
 */
export function buildShiftAction(
  s: ShiftRow,
  action: "accept" | "claim",
  external: boolean,
  membershipId: string | null = null,
  rule: "first-come" | "approval" | "seniority" = "first-come",
): MutationInput {
  const target =
    action === "claim"
      ? "app.claim_open_shift"
      : external
        ? "accept_engaged_shift"
        : "app.accept_shift";
  return {
    op: "rpc",
    target,
    table: "shifts",
    rowId: s.id,
    payload: { p_shift_id: s.id },
    policy: "cas",
    // Under first-come a claimed shift becomes the person's own at once, so it moves to My shifts while
    // queued; under approval or seniority (scheduling.open_shift_claiming) it stays open until a
    // supervisor decides.
    optimistic:
      action === "claim"
        ? rule === "first-come" && membershipId
          ? { ...s, membership_id: membershipId, shift_state: "Accepted" }
          : { ...s }
        : { ...s, shift_state: "Accepted" },
  };
}

/** "3h 20m" style countdown to the call time. */
export function startsIn(startsAt: string, nowMs: number): string | null {
  const ms = Date.parse(startsAt) - nowMs;
  if (ms <= 0) return null;
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const DAY_MS = 24 * 3600_000;

/** A countdown as a message: its catalog key and arguments. */
export interface Countdown {
  readonly key: string;
  readonly values: Readonly<Record<string, string>>;
}

/**
 * The shift card's countdown (finding A59-028): hours and minutes within a day of the call time,
 * whole days beyond it ("Starts in 145 days", never "Starts in 3492h 5m"), nothing once it started.
 */
export function shiftCountdown(startsAt: string, nowMs: number): Countdown | null {
  const ms = Date.parse(startsAt) - nowMs;
  if (!(ms > 0)) return null;
  if (ms <= DAY_MS) {
    return { key: "compass.schedule.startsIn", values: { time: startsIn(startsAt, nowMs) ?? "" } };
  }
  const days = Math.round(ms / DAY_MS);
  return {
    key: days === 1 ? "compass.schedule.startsInDaysOne" : "compass.schedule.startsInDaysOther",
    values: { count: String(days) },
  };
}

/**
 * The shift being worked now (finding A59-022): one of mine whose window, opened two hours before
 * the call time as Clock In allows, includes now. Any state but Canceled counts, so a shift clocked
 * into before it was accepted still shows on the On Shift card; the soonest start wins.
 */
export function currentShift<T extends ShiftRow>(shifts: readonly T[], nowMs: number): T | null {
  return (
    [...shifts]
      .filter(
        (s) =>
          s.shift_state !== "Canceled" &&
          s.shift_state !== "Draft" &&
          Date.parse(s.starts_at) - 2 * 3600_000 <= nowMs &&
          Date.parse(s.ends_at) >= nowMs,
      )
      .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0] ?? null
  );
}
