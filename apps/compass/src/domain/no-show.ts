/**
 * No-shows on the Crew tab (B9, migration 6512, ADR 0148): a supervisor marks a late crew member, offline too. The mark is
 * one queued change, app.mark_shift_no_show keyed by the client's id, so replaying it applies exactly once; the optimistic
 * row takes the person off the late list at once. The reason goes only in the call: it is Confidential, and the local row
 * holds what the download holds (id, org, project, shift and when).
 */
import { uuidv7, type MutationInput } from "@xos/sync";

export interface LateShift {
  readonly id: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly membership_id?: string | null;
}

/** Started, not over, with a member who is not on site and not already marked. */
export function lateCrew<S extends LateShift>(
  shifts: readonly S[],
  onSite: ReadonlySet<string | null | undefined>,
  noShows: ReadonlySet<string>,
  nowMs: number,
): S[] {
  return shifts.filter(
    (s) =>
      Date.parse(s.starts_at) < nowMs &&
      Date.parse(s.ends_at) > nowMs &&
      Boolean(s.membership_id) &&
      !onSite.has(s.membership_id) &&
      !noShows.has(s.id),
  );
}

/** The shifts with a live no-show: a withdrawn one stays on the device with its deleted_at, and the person is late again. */
export function markedShiftIds(
  rows: readonly { readonly shift_id: string; readonly deleted_at?: string | null }[],
): Set<string> {
  return new Set(rows.filter((n) => !n.deleted_at).map((n) => n.shift_id));
}

export function buildNoShow(
  input: {
    readonly shiftId: string;
    readonly orgId: string;
    readonly projectId: string;
    readonly reason: string;
  },
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const id = newId(nowMs);
  return {
    op: "rpc",
    target: "app.mark_shift_no_show",
    table: "shift_no_shows",
    rowId: id,
    payload: {
      p_no_show_id: id,
      p_shift_id: input.shiftId,
      p_reason: input.reason.trim(),
      p_open_replacement: false,
    },
    optimistic: {
      id,
      org_id: input.orgId,
      project_id: input.projectId,
      shift_id: input.shiftId,
      recorded_at: new Date(nowMs).toISOString(),
    },
  };
}
