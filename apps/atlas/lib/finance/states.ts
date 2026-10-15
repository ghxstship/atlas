import type { RecordState } from "@xos/ui";

/**
 * Finance lifecycles use their own state vocabularies (0320, 0321). State chips pair an icon with
 * the state's own catalog label, so color is never the only signal (Section 11.3); this maps each
 * finance state to the record state whose icon and hue carry the same meaning.
 */
const ICON_STATE: Readonly<Record<string, RecordState>> = {
  Proposed: "Proposed",
  Priced: "Ready",
  Issued: "Scheduled",
  Approved: "Active",
  Posted: "Complete",
  Paid: "Complete",
  Rejected: "Blocked",
  Disputed: "Blocked",
  Canceled: "Canceled",
  Open: "Ready",
  "In Period": "Active",
  Closing: "In Review",
  Closed: "Complete",
  Audited: "Complete",
  Archived: "Deferred",
  Reported: "Proposed",
  Dispatched: "Active",
  Contained: "In Review",
  Sent: "Scheduled",
};

export function iconState(state: string): RecordState {
  return ICON_STATE[state] ?? "Proposed";
}

export type Lifecycle =
  | "expense"
  | "change_order"
  | "invoice"
  | "payment"
  | "journal"
  | "accounting_period";

/** The catalog key of a state label: `finance.states.<lifecycle>.<state>` with spaces removed. */
export function stateKey(lifecycle: Lifecycle, state: string): string {
  return `finance.states.${lifecycle}.${state.replace(/\s+/g, "")}`;
}
