import type { Engagement } from "@xos/data/gateway";
import type { Condition } from "@xos/ia";

/**
 * The crew roster in Gateway (R4, ADR 0101). Pure, so who sees the Crew tab is unit tested.
 */

/**
 * ADR 0101 decision 8: an Artist engagement, or a company engagement (an account supplies it) of a
 * Vendor, Contractor, Staff or Sponsor, carries a roster beyond the engaged person's own entry.
 */
export function engagementRosterable(
  engagement: Pick<Engagement, "roleType" | "accountId">,
): boolean {
  if (engagement.roleType === "Artist") return true;
  return (
    engagement.accountId !== null &&
    ["Vendor", "Contractor", "Staff", "Sponsor"].includes(engagement.roleType)
  );
}

/**
 * roster-manager when the roster area is open to the viewer (the engaged person, the account's
 * Owner or Admin, an Advancing Lead, an Advance representative) on a rosterable engagement: the
 * database's private.can_manage_roster, read from the engagement's areas.
 */
export function rosterConditions(
  engagement: Pick<Engagement, "roleType" | "accountId" | "areas">,
): Condition[] {
  return engagement.areas.includes("roster") && engagementRosterable(engagement)
    ? ["roster-manager"]
    : [];
}
