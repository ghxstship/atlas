import type { RecordState } from "@xos/ui";

/**
 * Finance lifecycles use their own state vocabularies (0320, 0321). State chips pair an icon with
 * the state's own catalog label, so color is never the only signal (Section 11.3); this maps each
 * finance state to the record state whose icon and hue carry the same meaning.
 */
const ICON_STATE: Readonly<Record<string, RecordState>> = {
  Proposed: "proposed",
  Priced: "ready",
  Issued: "scheduled",
  Approved: "active",
  Posted: "complete",
  Paid: "complete",
  Rejected: "blocked",
  Disputed: "blocked",
  Canceled: "canceled",
  Open: "ready",
  "In Period": "active",
  Closing: "in-review",
  Closed: "complete",
  Audited: "complete",
  Archived: "deferred",
  Reported: "proposed",
  Dispatched: "active",
  Contained: "in-review",
  Sent: "scheduled",
  Submitted: "in-review",
  Accepted: "active",
};

export function iconState(state: string): RecordState {
  return ICON_STATE[state] ?? "proposed";
}

export type Lifecycle =
  | "expense"
  | "change_order"
  | "invoice"
  | "payment"
  | "journal"
  | "accounting_period"
  | "settlement";

/** The catalog key of a state label: `finance.states.<lifecycle>.<state>` with spaces removed. */
export function stateKey(lifecycle: Lifecycle, state: string): string {
  return `finance.states.${lifecycle}.${state.replace(/\s+/g, "")}`;
}
