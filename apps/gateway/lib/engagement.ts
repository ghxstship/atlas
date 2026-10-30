import { todayIn } from "@xos/data/calendar";
import {
  fromDisplayKey,
  getEngagement,
  listRepresentations,
  representationStanding,
  type Engagement,
  type Representation,
} from "@xos/data/gateway";
import { listEngagementOfferings, type EngagementOffering } from "@xos/data/offerings";
import {
  getNode,
  isNodeVisible,
  type Condition,
  type ExternalRoleType as SitemapRoleType,
} from "@xos/ia";
import { notFound } from "next/navigation";
import { cache } from "react";
import { engagementNav, offeringConditions, visibleEngagementTabs } from "./engagement-offerings";
import type { ScheduleView } from "./format";
import type { GatewayContext } from "./shell/context";
import { getScheduleView } from "./time-zone";
import { requireNode, sitemap } from "./shell/sitemap";

/**
 * The engagement record (Section 4.5.8): the engagement a URL names, how the viewer stands to it
 * (the engaged party, an account member, or an artist's representative within scopes) and the tabs
 * of their role type, all from the sitemap. Anything not open to the viewer answers 404.
 */

/** Sitemap role type keys for the stored external role types. */
export function sitemapRoleType(stored: Engagement["roleType"]): SitemapRoleType {
  return stored.toLowerCase().replace(/\s+/g, "-") as SitemapRoleType;
}

export interface EngagementView {
  readonly ctx: GatewayContext;
  readonly engagement: Engagement;
  /** The role type whose tabs render: the engagement's, or artist-representative. */
  readonly roleType: SitemapRoleType;
  readonly representation: Representation | null;
  /** Representation scopes as sitemap keys (offers, advance, settlement, documents). */
  readonly scopes: readonly string[];
  /** What the producing org offers on the engagement (R3), one row per offering. */
  readonly offerings: readonly EngagementOffering[];
  /** Sitemap conditions the offerings meet (offeringConditions), on top of the shell's. */
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
  const [engagement, representations, scheduleView, offerings] = await Promise.all([
    getEngagement(ctx.db, id),
    listRepresentations(ctx.db),
    getScheduleView(ctx),
    listEngagementOfferings(ctx.db, id),
  ]);
  if (!engagement.ok) {
    if (engagement.error.kind === "not-found") notFound();
    throw new Error(`Engagement ${engagementKey} did not load: ${engagement.error.kind}`);
  }
  if (!offerings.ok) {
    throw new Error(
      `Offerings of engagement ${engagementKey} did not load: ${offerings.error.kind}`,
    );
  }
  if (ctx.brand.kind === "org" && ctx.brand.org.orgId !== engagement.data.orgId) notFound();
  const today = todayIn(engagement.data.projectTimeZone);
  const representation = representationFor(
    engagement.data,
    ctx.personId,
    representations.ok ? representations.data : [],
    today,
  );
  const roleType: SitemapRoleType = representation
    ? "artist-representative"
    : sitemapRoleType(engagement.data.roleType);
  const scopes = representation ? representation.scopes.map((s) => s.toLowerCase()) : [];
  const conditions = offeringConditions(offerings.data);
  return {
    ctx,
    engagement: engagement.data,
    roleType,
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

export { closedArea, isLiveEngagement, type ClosedArea } from "./engagement-state";
export { offeringConditions } from "./engagement-offerings";
