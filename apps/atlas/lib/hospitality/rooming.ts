import type { RoomingEntry, RoomingStatus, SuggestedStay } from "@xos/data/lodging";

/**
 * Pure helpers of the rooming list (B5, G-67): its filters and the stay Assign room starts from. The list itself is
 * read on request, because every read is logged per person (R5).
 */

/** The statuses the rooming filters offer, in the order the table shows them. */
export const ROOMING_FILTERS: readonly Exclude<RoomingStatus, "Covered">[] = [
  "Missing",
  "Partial",
  "No Dates",
];

/** Entries in the chosen statuses; every entry when none is chosen. */
export function filterRooming(
  entries: readonly RoomingEntry[],
  statuses: ReadonlySet<RoomingStatus>,
): RoomingEntry[] {
  return statuses.size === 0 ? [...entries] : entries.filter((e) => statuses.has(e.status));
}

/** The nights of a stay as YYYY-MM-DD, check-in to the night before check-out. */
export function stayNights(stay: { checkInOn: string; checkOutOn: string }): string[] {
  const out: string[] = [];
  for (
    let t = Date.parse(`${stay.checkInOn}T00:00:00Z`);
    t < Date.parse(`${stay.checkOutOn}T00:00:00Z`);
    t += 86_400_000
  ) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The stay Assign room proposes: the first suggested stay with a night no assignment covers, else the first
 * suggested stay. Null with nothing suggested (No Dates), so the form starts empty.
 */
export function stayToAssign(entry: RoomingEntry): SuggestedStay | null {
  const covered = new Set(entry.assignedStays.flatMap(stayNights));
  return (
    entry.suggestedStays.find((s) => stayNights(s).some((n) => !covered.has(n))) ??
    entry.suggestedStays[0] ??
    null
  );
}

/** Blocks a stay fits inside, for the assignment form's block select. */
export function blocksFor<B extends { checkInOn: string; checkOutOn: string }>(
  blocks: readonly B[],
  stay: SuggestedStay | null,
): B[] {
  if (!stay) return [...blocks];
  const fits = blocks.filter(
    (b) => b.checkInOn <= stay.checkInOn && b.checkOutOn >= stay.checkOutOn,
  );
  return fits.length > 0 ? fits : [...blocks];
}
