import type { QuoteDisplayState } from "@xos/data/quotes";
import type { RecordState } from "@xos/ui";

/** Each quote state's record state, whose icon and hue carry the same meaning (Section 11.3). */
export const CLIENT_QUOTE_STATE: Readonly<Record<QuoteDisplayState, RecordState>> = {
  Draft: "proposed",
  Sent: "scheduled",
  Expired: "blocked",
  Accepted: "complete",
  Declined: "blocked",
  Withdrawn: "canceled",
  Superseded: "deferred",
};
