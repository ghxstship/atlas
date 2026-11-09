import type { RosterCopyItem } from "@xos/data/roster";

/**
 * The roster reuse preview grouped as Gateway shows it (B14, G-252): who is added (as Draft entries each person still
 * accepts), which addresses are invited again (one email each, on commit only) and who is skipped and why. Pure, for
 * the Crew tab and its test (test/roster-copy.test.ts).
 */
export interface RosterCopyGroups {
  readonly added: readonly RosterCopyItem[];
  readonly invited: readonly RosterCopyItem[];
  readonly skipped: readonly RosterCopyItem[];
  /** True when nothing would be added or invited, so Add to roster stays off. */
  readonly empty: boolean;
}

export function rosterCopyGroups(items: readonly RosterCopyItem[]): RosterCopyGroups {
  const added = items.filter((i) => i.outcome === "copy");
  const invited = items.filter((i) => i.outcome === "invite");
  const skipped = items.filter((i) => i.outcome === "skip");
  return { added, invited, skipped, empty: added.length + invited.length === 0 };
}
