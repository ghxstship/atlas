import type { RecordState } from "@xos/ui";

/** How each People lifecycle state is drawn: icon and hue, never color alone (Section 11.3). */
const ICONS: Record<string, Record<string, RecordState>> = {
  requisition: {
    Proposed: "in-review",
    Approved: "ready",
    Rejected: "blocked",
    Filled: "complete",
    Canceled: "canceled",
  },
  assignment: {
    Proposed: "proposed",
    Active: "active",
    Complete: "complete",
    Canceled: "canceled",
  },
  agreement: {
    Proposed: "proposed",
    Sent: "scheduled",
    Signed: "complete",
    Superseded: "deferred",
    Expired: "canceled",
    Canceled: "canceled",
  },
  offer: {
    Sent: "scheduled",
    Countered: "in-review",
    Accepted: "complete",
    Declined: "blocked",
    Withdrawn: "canceled",
    Expired: "canceled",
  },
  certificate: { current: "complete", expiring: "deferred", expired: "blocked" },
};

export type PeopleLifecycle = "requisition" | "assignment" | "agreement" | "offer" | "certificate";

export function peopleStateIcon(lifecycle: PeopleLifecycle, value: string): RecordState {
  return ICONS[lifecycle]?.[value] ?? "proposed";
}
