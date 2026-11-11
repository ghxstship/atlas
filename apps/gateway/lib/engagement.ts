import { todayIn } from "@xos/data/calendar";
import {
  fromDisplayKey,
  listRepresentations,
  representationStanding,
  type Engagement,
  type Representation,
} from "@xos/data/gateway";
import type { RosterEngagement } from "@xos/data/gateway-allocations";
import { listEngagementOfferings, type EngagementOffering } from "@xos/data/offerings";
import { getNode, isNodeVisible, type Condition, type EngagementTabSetKey } from "@xos/ia";
import { notFound } from "next/navigation";
import { cache } from "react";
import { engagementNav, offeringConditions, visibleEngagementTabs } from "./engagement-offerings";
import type { ScheduleView } from "./format";
import type { GatewayContext } from "./shell/context";
import { rosterConditions } from "./roster";
import { engagementTabSet, resolveEngagement } from "./roster-member";
import { getScheduleView } from "./time-zone";
import { requireNode, sitemap } from "./shell/sitemap";

/**
 * The engagement record (Section 4.5.8): the engagement a URL names, how the viewer stands to it
 * (the engaged party, an account member, an artist's representative within scopes, or a person on
 * the party's roster, R8) and the tabs of their set, all from the sitemap. Anything not open to the
 * viewer answers 404.
 */

export interface EngagementView {
  readonly ctx: GatewayContext;
  readonly engagement: Engagement;
  /**
   * The tab set that renders: the engagement's role type, artist-representative, or roster-member
   * when the viewer reaches the engagement only through an Accepted roster entry (R8, ADR 0100).
   */
  readonly roleType: EngagementTabSetKey;
  /** The viewer's roster entry, for a roster member; null otherwise. */
  readonly rosterEntryId: string | null;
  /** The entry's arrival and whom to ask, for a roster member; null otherwise. */
  readonly rosterEngagement: RosterEngagement | null;
  readonly representation: Representation | null;
  /** Representation scopes as sitemap keys (offers, advance, settlement, documents). */
  readonly scopes: readonly string[];
  /** What the producing org offers on the engagement (R3), one row per offering. */
  readonly offerings: readonly EngagementOffering[];
  /** Sitemap conditions the offerings (offeringConditions) and the roster (rosterConditions, R4) meet, on top of the shell's. */
  readonly conditions: readonly Condition[];
  readonly tabs: readonly string[];
  /** Today on the engagement's project calendar (its time zone, 1390), as `YYYY-MM-DD`; never UTC's date. */
  readonly today: string;
  /** How the viewer reads schedule times (me.time_zone_display): the project's zone or their own. */
  readonly scheduleView: ScheduleView;
}

/** How the viewer relates to an artist engagement they do not hold: through a live representation. */
export function representationFor(
  engagement: Engagement,
  personId: string,
  representations: readonly Representation[],
  today: string,
): Representation | null {
  if (
    engagement.roleType !== "Artist" ||
    engagement.personId === null ||
    engagement.personId === personId
  ) {
    return null;
  }
  return (
    representations.find(
      (r) =>
        r.artistPersonId === engagement.personId && representationStanding(r, today) === "active",
    ) ?? null
  );
}

export const loadEngagementView = cache(async (engagementKey: string): Promise<EngagementView> => {
  const ctx = await requireNode("engagement", { engagementKey });
  const id = fromDisplayKey("engagement", engagementKey);
  if (!id) notFound();
  const [reach, representations, scheduleView, offerings] = await Promise.all([
    resolveEngagement(ctx.db, id),
    listRepresentations(ctx.db),
    getScheduleView(ctx),
    listEngagementOfferings(ctx.db, id),
  ]);
  if (!reach.ok) {
    if (reach.error.kind === "not-found") notFound();
    throw new Error(`Engagement ${engagementKey} did not load: ${reach.error.kind}`);
  }
  const engagement: Engagement = reach.data.engagement;
  const rosterEngagement = reach.data.via === "roster" ? reach.data.engagement : null;
  if (!offerings.ok) {
    throw new Error(
      `Offerings of engagement ${engagementKey} did not load: ${offerings.error.kind}`,
    );
  }
  if (ctx.brand.kind === "org" && ctx.brand.org.orgId !== engagement.orgId) notFound();
  const today = todayIn(engagement.projectTimeZone);
  const representation = rosterEngagement
    ? null
    : representationFor(
        engagement,
        ctx.personId,
        representations.ok ? representations.data : [],
        today,
      );
  const roleType = engagementTabSet(reach.data, representation);
  const scopes = representation ? representation.scopes.map((s) => s.toLowerCase()) : [];
  // A person on the roster manages nothing of it, so the roster conditions are the party's only.
  const conditions = [
    ...offeringConditions(offerings.data),
    ...(rosterEngagement ? [] : rosterConditions(engagement)),
  ];
  return {
    ctx,
    engagement,
    roleType,
    rosterEntryId: rosterEngagement?.rosterEntryId ?? null,
    rosterEngagement,
    representation,
    scopes,
    offerings: offerings.data,
    conditions,
    tabs: visibleEngagementTabs(sitemap, ctx.nav, roleType, scopes, conditions),
    today,
    scheduleView,
  };
});

/** The view for one tab, or 404 when the tab is not in the viewer's set (Section 4.5.8 Visibility). */
export async function loadEngagementTab(
  engagementKey: string,
  tab: string,
): Promise<EngagementView> {
  const view = await loadEngagementView(engagementKey);
  const visible = isNodeVisible(
    sitemap,
    tab,
    engagementNav(view.ctx.nav, view.roleType, view.scopes, view.conditions),
  );
  if (!visible || !view.tabs.includes(tab)) notFound();
  return view;
}

/** The URL of an engagement tab. */
export function tabHref(engagementKey: string, tab: string): string {
  const route = getNode(sitemap, tab).node.route ?? "";
  return route.replace("{engagementKey}", engagementKey);
}

/** Whether the engagement has a Section 8.7 area open to the viewer. */
export function hasArea(view: EngagementView, area: string): boolean {
  return view.engagement.areas.includes(area as never);
}

export { closedArea, isLiveEngagement, sitemapRoleType, type ClosedArea } from "./engagement-state";
export { offeringConditions } from "./engagement-offerings";
