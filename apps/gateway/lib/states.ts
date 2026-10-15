import type { ApplicationState, EngagementState } from "@xos/data/gateway";
import type { RecordState } from "@xos/ui";

/**
 * How Gateway lifecycle states borrow the nine record-state styles of the design system (icon and
 * color) on boards and chips. Labels always come from the catalogs for the real state; only the
 * visual style is shared.
 */
export const ENGAGEMENT_STATE_STYLE: Readonly<Record<EngagementState, RecordState>> = {
  Onboarding: "ready",
  Blocked: "blocked",
  Active: "active",
  Closing: "in-review",
  Complete: "complete",
  Canceled: "canceled",
};

export const APPLICATION_STATE_STYLE: Readonly<Record<ApplicationState, RecordState>> = {
  Submitted: "proposed",
  "In Review": "in-review",
  Shortlisted: "ready",
  Offered: "scheduled",
  Accepted: "complete",
  Declined: "canceled",
  Withdrawn: "deferred",
  "Not Selected": "canceled",
};

/** Tag tones for states shown as tags (documents, invoices, offers). */
export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export function toneFor(state: string): Tone {
  if (["Executed", "Signed", "Approved", "Accepted", "Complete", "Paid", "Passed"].includes(state)) return "success";
  if (["Sent", "Offered", "Countered", "Issued", "Submitted", "In Review", "Published"].includes(state)) return "accent";
  if (["Blocked", "Disputed", "Returned", "Expired", "Rejected", "Failed"].includes(state)) return "danger";
  if (["Proposed", "Draft", "Onboarding"].includes(state)) return "warning";
  return "neutral";
}
