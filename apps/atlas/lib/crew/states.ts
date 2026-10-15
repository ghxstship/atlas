import type { RecordState } from "@xos/ui";

/**
 * How each Crew lifecycle state is drawn (Section 11.3: state is shown by icon and hue, never color
 * alone). The stored values stay the database enums; labels come from `crew.states.<lifecycle>`.
 */

export type Lifecycle =
  | "shift"
  | "swap"
  | "timesheet"
  | "correction"
  | "entry"
  | "payPeriod"
  | "payrollRun"
  | "timeOff"
  | "rateCard";

const ICONS: Record<Lifecycle, Record<string, RecordState>> = {
  shift: { Draft: "proposed", Published: "scheduled", Accepted: "ready", Canceled: "canceled" },
  swap: { Proposed: "in-review", Approved: "complete", Rejected: "blocked", Canceled: "canceled" },
  timesheet: {
    Proposed: "proposed",
    Submitted: "in-review",
    Approved: "complete",
    Rejected: "blocked",
  },
  correction: { Proposed: "in-review", Approved: "complete", Rejected: "blocked" },
  entry: { Open: "active", Closed: "complete" },
  payPeriod: { Open: "active", Closed: "in-review", Posted: "complete" },
  payrollRun: {
    Draft: "proposed",
    Calculated: "in-review",
    Approved: "ready",
    Exported: "active",
    Accepted: "complete",
    Canceled: "canceled",
  },
  timeOff: {
    Proposed: "in-review",
    Approved: "complete",
    Rejected: "blocked",
    Canceled: "canceled",
  },
  rateCard: { Upcoming: "scheduled", Current: "active", Ended: "complete" },
};

export function stateIcon(lifecycle: Lifecycle, value: string): RecordState {
  return ICONS[lifecycle][value] ?? "proposed";
}

/** States of a lifecycle in display order, for board columns and filters. */
export function lifecycleStates(lifecycle: Lifecycle): string[] {
  return Object.keys(ICONS[lifecycle]);
}

/** A rate card is upcoming, current or ended on a day (ISO dates compare as strings). */
export function rateCardPhase(
  card: { effectiveFrom: string; effectiveTo: string | null },
  day: string,
) {
  if (card.effectiveFrom > day) return "Upcoming";
  if (card.effectiveTo !== null && card.effectiveTo < day) return "Ended";
  return "Current";
}
