import type { EngagementOffering } from "@xos/data/offerings";
import {
  engagementTabIds,
  isNodeVisible,
  type Condition,
  type ExternalRoleType,
  type NavContext,
  type Sitemap,
} from "@xos/ia";

/**
 * What the producing org offers on an engagement, as Gateway tabs (R3, owner decision 7). Offerings
 * default to Not Offered, so the Travel and lodging, Per diem, Hospitality and Guest list tabs appear
 * only on engagements whose project, org or audience rule offers them. Pure, so the tab sets each
 * offering opens are unit tested.
 */

/**
 * The sitemap conditions an engagement's offerings meet: Travel and lodging when travel or lodging
 * is offered, Per diem for per diem, Hospitality when catering, lodging or travel is, and Guest list
 * for a guest list. An offering that is absent or Not Offered meets none.
 */
export function offeringConditions(rows: readonly EngagementOffering[]): Condition[] {
  const offered = new Set(rows.filter((r) => r.mode !== "Not Offered").map((r) => r.offering));
  const conditions: Condition[] = [];
  if (offered.has("Travel") || offered.has("Lodging")) conditions.push("offered-travel-or-lodging");
  if (offered.has("Per Diem")) conditions.push("offered-per-diem");
  if (offered.has("Catering") || offered.has("Lodging") || offered.has("Travel")) {
    conditions.push("offered-hospitality");
  }
  if (offered.has("Guest List")) conditions.push("offered-guest-list");
  return conditions;
}

/** The shell's navigation context with an engagement's role type, scopes and offering conditions. */
export function engagementNav(
  nav: NavContext,
  roleType: ExternalRoleType,
  scopes: readonly string[],
  conditions: readonly Condition[],
): NavContext {
  return {
    ...nav,
    conditions: [...(nav.conditions ?? []), ...conditions],
    roleType,
    representationScopes: scopes,
  };
}

/** The engagement tabs the viewer sees: the role type's set, less the tabs whose conditions fail. */
export function visibleEngagementTabs(
  sitemap: Sitemap,
  nav: NavContext,
  roleType: ExternalRoleType,
  scopes: readonly string[],
  conditions: readonly Condition[],
): string[] {
  const ctx = engagementNav(nav, roleType, scopes, conditions);
  return engagementTabIds(sitemap, roleType, scopes).filter((id) =>
    isNodeVisible(sitemap, id, ctx),
  );
}
