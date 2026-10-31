import type { BulkConfig } from "@/components/bulk/types";
import type { RosterEntry, RosterEntryState } from "@xos/data/roster";
import type { RecordState } from "@xos/ui";

/**
 * The crew roster's review rules in Atlas (R4), pure so they are unit tested: which rows show, how
 * they group by party, the chip each state takes, and the bulk review a reviewer gets (Accept or Return
 * with one reason, never another state).
 */

export const ROSTER_RECORD_STATE: Readonly<Record<RosterEntryState, RecordState>> = {
  Draft: "proposed",
  Submitted: "in-review",
  Accepted: "ready",
  Returned: "blocked",
  Withdrawn: "canceled",
};

/** The rows a filter shows: one state, or every entry still on a roster (withdrawn ones only on request). */
export function visibleRosterRows(
  rows: readonly RosterEntry[],
  state: RosterEntryState | undefined,
): RosterEntry[] {
  return rows.filter((e) => (state ? e.entryState === state : e.entryState !== "Withdrawn"));
}

/** Rows grouped by party name, parties in name order, each group in the order given. */
export function groupByParty(
  rows: readonly RosterEntry[],
): { party: string; rows: RosterEntry[] }[] {
  const groups = new Map<string, RosterEntry[]>();
  for (const row of rows) {
    const party = row.partyName ?? "";
    groups.set(party, [...(groups.get(party) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([party, list]) => ({ party, rows: list }));
}

/** The bulk review a reviewer gets, or none: entry_state to Accepted or Returned, asking one reason. */
export function crewBulkConfig(
  org: string,
  canReview: boolean,
  labels: { readonly state: string; readonly accept: string; readonly return: string },
): BulkConfig | null {
  if (!canReview) return null;
  return {
    org,
    resource: "engagement_roster_entries",
    fields: [
      {
        key: "entry_state",
        label: labels.state,
        reason: true,
        options: [
          { value: "Accepted", label: labels.accept },
          { value: "Returned", label: labels.return },
        ],
      },
    ],
  };
}
