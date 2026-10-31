import type { EngagementOffering, OfferingKind } from "@xos/data/offerings";
import { loadSitemapFile } from "@xos/ia/node";
import { describe, expect, it } from "vitest";
import { offeringConditions, visibleEngagementTabs } from "../lib/engagement-offerings";
import { navContext } from "../lib/shell/standing";

/**
 * Engagement tabs follow the producing org's offerings (R3, owner decision 7): every offering
 * defaults to Not Offered, so Travel and lodging, Per diem, Hospitality and Guest list appear only
 * when the engagement's project, org or audience rule offers them.
 */
const sitemap = loadSitemapFile(new URL("../ia/sitemap.yaml", import.meta.url));
const nav = navContext({
  standing: "individual",
  companyAccount: false,
  platformDomain: true,
  desktop: true,
});

function offered(...kinds: OfferingKind[]): EngagementOffering[] {
  return kinds.map((offering) => ({
    offering,
    mode: "Provided",
    capPerEngagement: null,
    capPerPerson: null,
  }));
}

const notOffered: EngagementOffering[] = (
  ["Travel", "Lodging", "Catering", "Per Diem", "Guest List"] as const
).map((offering) => ({
  offering,
  mode: "Not Offered",
  capPerEngagement: null,
  capPerPerson: null,
}));

const tabsOf = (
  roleType: Parameters<typeof visibleEngagementTabs>[2],
  rows: EngagementOffering[],
  scopes: string[] = [],
) => visibleEngagementTabs(sitemap, nav, roleType, scopes, offeringConditions(rows));

describe("offering conditions", () => {
  it("meets nothing when every offering is Not Offered or absent", () => {
    expect(offeringConditions([])).toEqual([]);
    expect(offeringConditions(notOffered)).toEqual([]);
  });

  it("names each condition its offerings meet", () => {
    expect(offeringConditions(offered("Travel"))).toEqual([
      "offered-travel-or-lodging",
      "offered-hospitality",
      "offered-project-facts",
    ]);
    expect(offeringConditions(offered("Lodging"))).toEqual([
      "offered-travel-or-lodging",
      "offered-hospitality",
    ]);
    expect(offeringConditions(offered("Catering"))).toEqual(["offered-hospitality"]);
    expect(offeringConditions(offered("Per Diem"))).toEqual(["offered-per-diem"]);
    expect(offeringConditions(offered("Guest List"))).toEqual(["offered-guest-list"]);
    expect(offeringConditions(offered("Radios", "Carts"))).toEqual([]);
    // Uniforms and parking ask the person for project facts (R5).
    expect(offeringConditions(offered("Uniforms"))).toEqual(["offered-project-facts"]);
    expect(offeringConditions(offered("Parking"))).toEqual(["offered-project-facts"]);
  });

  it("counts Reimbursed and Buyout as offered", () => {
    expect(
      offeringConditions([
        { offering: "Per Diem", mode: "Buyout", capPerEngagement: null, capPerPerson: null },
        { offering: "Travel", mode: "Reimbursed", capPerEngagement: null, capPerPerson: 2 },
      ]),
    ).toEqual([
      "offered-travel-or-lodging",
      "offered-per-diem",
      "offered-hospitality",
      "offered-project-facts",
    ]);
  });
});

describe("engagement tabs by offering", () => {
  it("hides crew Travel and lodging unless travel or lodging is offered", () => {
    expect(tabsOf("crew", notOffered)).not.toContain("engagement.travel-and-lodging");
    expect(tabsOf("crew", offered("Travel"))).toContain("engagement.travel-and-lodging");
    expect(tabsOf("crew", offered("Lodging"))).toContain("engagement.travel-and-lodging");
    expect(tabsOf("crew", offered("Catering"))).not.toContain("engagement.travel-and-lodging");
  });

  it("hides crew Per diem unless per diem is offered", () => {
    expect(tabsOf("crew", notOffered)).not.toContain("engagement.per-diem");
    expect(tabsOf("crew", offered("Per Diem"))).toContain("engagement.per-diem");
  });

  it("keeps every other crew tab whatever is offered", () => {
    expect(tabsOf("crew", notOffered)).toEqual([
      "engagement.overview",
      "engagement.offer",
      "engagement.onboarding",
      "engagement.shifts",
      "engagement.timesheets",
      "engagement.invoices",
      "engagement.credentials",
      "engagement.documents",
      "engagement.messages",
    ]);
  });

  it("shows Project details only when travel, uniforms or parking is offered (R5)", () => {
    expect(tabsOf("crew", notOffered)).not.toContain("engagement.project-details");
    expect(tabsOf("crew", offered("Lodging", "Catering"))).not.toContain(
      "engagement.project-details",
    );
    for (const kind of ["Travel", "Uniforms", "Parking"] as const) {
      expect(tabsOf("crew", offered(kind))).toContain("engagement.project-details");
      expect(tabsOf("staff", offered(kind))).toContain("engagement.project-details");
      expect(tabsOf("artist", offered(kind))).toContain("engagement.project-details");
    }
    expect(tabsOf("artist-representative", offered("Parking"), ["advance"])).toContain(
      "engagement.project-details",
    );
  });

  it("gates artist Hospitality and Guest list", () => {
    const none = tabsOf("artist", notOffered);
    expect(none).not.toContain("engagement.hospitality");
    expect(none).not.toContain("engagement.guest-list");
    expect(tabsOf("artist", offered("Catering"))).toContain("engagement.hospitality");
    expect(tabsOf("artist", offered("Guest List"))).toEqual(
      expect.arrayContaining(["engagement.guest-list"]),
    );
    expect(tabsOf("artist", offered("Guest List"))).not.toContain("engagement.hospitality");
  });

  it("filters an artist representative's delegated tabs the same way", () => {
    const none = tabsOf("artist-representative", notOffered, ["advance"]);
    expect(none).toContain("engagement.advance");
    expect(none).not.toContain("engagement.hospitality");
    expect(none).not.toContain("engagement.guest-list");
    const all = tabsOf("artist-representative", offered("Catering", "Guest List"), ["advance"]);
    expect(all).toContain("engagement.hospitality");
    expect(all).toContain("engagement.guest-list");
    expect(tabsOf("artist-representative", offered("Guest List"), [])).not.toContain(
      "engagement.guest-list",
    );
  });
});
