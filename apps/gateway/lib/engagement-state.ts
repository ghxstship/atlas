import type { Engagement } from "@xos/data/gateway";

/**
 * What an engagement's state means for its tabs (Section 8.7 time box). Operational records open
 * when the engagement becomes Active and close at Complete or Canceled; money and documents stay
 * open for 18 months after Complete. Pure, so the copy each state gets is unit tested.
 */

type State = Engagement["state"];

/** A row of the engagement Overview's property card. */
export type OverviewRow =
  | "org"
  | "project"
  | "role"
  | "engagement"
  | "package"
  | "dates"
  | "rate"
  | "payBasis"
  | "contractValue"
  | "billingBasis"
  | "sponsorshipFee"
  | "approvalsWaiting"
  | "entitlements";

/**
 * The Overview property rows for a role type (Section 4.5.8). People the org pays (crew, staff,
 * contractors, vendors, artists and their representatives) see their rate and pay basis. A client
 * pays the org, so it sees the contract value, its billing basis and the approvals waiting on it;
 * a sponsor contributes, so it sees its package, fee and entitlement progress. Neither is shown a
 * role or a rate, which would read as if the org paid them.
 */
export function overviewRows(roleType: string): readonly OverviewRow[] {
  switch (roleType) {
    case "client":
      return [
        "org",
        "project",
        "engagement",
        "dates",
        "contractValue",
        "billingBasis",
        "approvalsWaiting",
      ];
    case "sponsor":
      return ["org", "project", "package", "dates", "sponsorshipFee", "entitlements"];
    default:
      return ["org", "project", "role", "dates", "rate", "payBasis"];
  }
}

/** Role types the org never pays: they have no payout, tax or work details to keep. */
export const UNPAID_ROLE_TYPES: readonly Engagement["roleType"][] = ["Client", "Sponsor"];

/**
 * Whether a person does paid work through Gateway: true unless every engagement they can see is a
 * client or sponsor engagement. Someone with no engagement yet is looking for work, so they keep
 * Work Details and Payout and Tax to set up before their first offer.
 */
export function doesPaidWork(roleTypes: readonly Engagement["roleType"][]): boolean {
  return roleTypes.length === 0 || roleTypes.some((r) => !UNPAID_ROLE_TYPES.includes(r));
}

/** Active or Closing: the engagement's operational work is live, so its actions are offered. */
export function isLiveEngagement(state: State): boolean {
  return state === "Active" || state === "Closing";
}

/** Why a time-boxed section is closed, and the one action that helps (Section 11.10, rule 10). */
export interface ClosedArea {
  /** Catalog key of the sentence. */
  readonly sentence: string;
  /** Catalog key of the action label. */
  readonly action: string;
  /** The engagement tab the action opens. */
  readonly tab: string;
}

/**
 * The closed-section copy for an engagement state and the viewer's tab set. Before Active the
 * sentence names the way there (onboarding, or the organization starting the work); after
 * Complete or Canceled it says the section has closed and links to what stays open.
 */
export function closedArea(state: State, tabs: readonly string[]): ClosedArea {
  const first = (...ids: string[]): string | undefined => ids.find((id) => tabs.includes(id));
  const actionFor = (tab: string): string =>
    ({
      "engagement.invoices": "gateway.engagement.invoicesAction",
      "engagement.documents": "gateway.engagement.documentsAction",
      "engagement.onboarding": "gateway.engagement.onboardingAction",
      "engagement.messages": "gateway.engagement.messagesAction",
    })[tab] ?? "gateway.engagement.overviewAction";
  const closed = (sentence: string, tab: string): ClosedArea => ({
    sentence,
    action: actionFor(tab),
    tab,
  });
  switch (state) {
    case "Complete":
      return closed(
        "gateway.engagement.closed.complete",
        first("engagement.invoices", "engagement.documents") ?? "engagement.overview",
      );
    case "Canceled":
      return closed(
        "gateway.engagement.closed.canceled",
        first("engagement.documents") ?? "engagement.overview",
      );
    case "Onboarding":
    case "Blocked":
      return first("engagement.onboarding")
        ? closed("gateway.engagement.closed.beforeActive", "engagement.onboarding")
        : closed(
            "gateway.engagement.closed.beforeActiveOrg",
            first("engagement.messages") ?? "engagement.overview",
          );
    default:
      return closed(
        "gateway.engagement.closed.notOpen",
        first("engagement.messages") ?? "engagement.overview",
      );
  }
}
