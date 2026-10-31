/**
 * Who works a shift, as the shift editor's one Person select carries it (R12): a member (their membership id), a
 * staffing agency's slot (`agency:<engagement>`) or a person on the agency's roster (`staff:<entry>:<engagement>`).
 * An empty value plans an open shift. A shift names at most one worker column (shifts_one_worker); agency staff are
 * placed through app.assign_roster_shift, so their training and acceptance always apply.
 */
export type WorkerChoice =
  | { readonly kind: "open" }
  | { readonly kind: "member"; readonly membershipId: string }
  | { readonly kind: "agency"; readonly engagementId: string }
  | { readonly kind: "staff"; readonly rosterEntryId: string; readonly engagementId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeWorker(choice: WorkerChoice): string {
  switch (choice.kind) {
    case "open":
      return "";
    case "member":
      return choice.membershipId;
    case "agency":
      return `agency:${choice.engagementId}`;
    case "staff":
      return `staff:${choice.rosterEntryId}:${choice.engagementId}`;
  }
}

/** The choice a submitted value names, or null for one that is not well formed. */
export function decodeWorker(value: string): WorkerChoice | null {
  if (value === "") return { kind: "open" };
  if (UUID.test(value)) return { kind: "member", membershipId: value };
  const [kind, a, b] = value.split(":");
  if (kind === "agency" && a && UUID.test(a) && b === undefined)
    return { kind: "agency", engagementId: a };
  if (kind === "staff" && a && b && UUID.test(a) && UUID.test(b))
    return { kind: "staff", rosterEntryId: a, engagementId: b };
  return null;
}

/** The editor's value for a shift as it stands. */
export function workerValue(shift: {
  readonly member: { readonly membershipId: string; readonly engagementId?: string | null } | null;
  readonly rosterEntryId?: string | null;
  readonly agencySlot?: { readonly engagementId: string } | null;
}): string {
  if (shift.agencySlot)
    return encodeWorker({ kind: "agency", engagementId: shift.agencySlot.engagementId });
  if (shift.rosterEntryId) return `staff:${shift.rosterEntryId}`;
  return shift.member?.membershipId ?? "";
}
