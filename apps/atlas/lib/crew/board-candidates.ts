import type { RosterShiftCandidate, ShiftCandidate, StatedAvailability } from "@xos/data/crew";

/** One person on the schedule's drag list: an org member, or a person of an agency's roster on the project (R12). */
export type BoardCandidate =
  | (ShiftCandidate & { readonly kind: "member" })
  | (RosterShiftCandidate & { readonly kind: "staff" });

const AVAILABILITY_ORDER: readonly StatedAvailability[] = [
  "Available",
  "Tentative",
  "Unstated",
  "Unavailable",
];

/** The key that names a candidate on the board, unique across members and agency staff. */
export function candidateKey(c: BoardCandidate): string {
  return c.kind === "member" ? `m:${c.membershipId}` : `r:${c.rosterEntryId}`;
}

/**
 * Members and agency staff in one ranking, by the rule both RPCs rank by (app.rank_shift_candidates and
 * app.rank_roster_candidates): free of an overlapping shift, then (agency staff) nothing due in training, then
 * stated availability, then the role worked before, then the fewest hours that week, then the name.
 */
export function mergeCandidates(
  members: readonly ShiftCandidate[],
  staff: readonly RosterShiftCandidate[],
): BoardCandidate[] {
  const all: BoardCandidate[] = [
    ...members.map((m) => ({ ...m, kind: "member" as const })),
    ...staff.map((r) => ({ ...r, kind: "staff" as const })),
  ];
  const blocked = (c: BoardCandidate) => (c.kind === "staff" && c.trainingDue > 0 ? 1 : 0);
  return all.sort(
    (a, b) =>
      Number(a.conflict) - Number(b.conflict) ||
      blocked(a) - blocked(b) ||
      AVAILABILITY_ORDER.indexOf(a.availability) - AVAILABILITY_ORDER.indexOf(b.availability) ||
      Number(b.workedRole) - Number(a.workedRole) ||
      a.weekMinutes - b.weekMinutes ||
      (a.name ?? "￿").localeCompare(b.name ?? "￿"),
  );
}
