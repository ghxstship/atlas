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

export type ShiftAction = "accept" | "claim" | null;

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
    optimistic: { ...s, shift_state: "Accepted" },
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
