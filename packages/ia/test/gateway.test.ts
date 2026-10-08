import { describe, expect, it } from "vitest";
import {
  chromeSlot,
  commandMenuIndex,
  engagementTabs,
  EXTERNAL_ROLE_TYPES,
  flattenRoutes,
  guardRoute,
  indexSitemap,
  MAX_DEPTH,
  navigationTree,
  resolveBreadcrumbs,
  validateSitemap,
  type ExternalRoleType,
} from "../src/index.ts";
import { childIds, labelOf, loadApp, messages, treeIds } from "./support.ts";

const gateway = loadApp("gateway");
const label = (id: string) => labelOf(indexSitemap(gateway).byId.get(id)?.node.label ?? "");

/** Section 4.5.8 engagement tabs by role type, in order. */
const TAB_SETS: Record<Exclude<ExternalRoleType, "artist-representative">, string[]> = {
  client: [
    "Overview",
    "Approvals",
    "Schedule",
    "Run of Show",
    "Change Orders",
    "Reports",
    "Invoices",
    "Documents",
    "Messages",
  ],
  vendor: [
    "Overview",
    "Bid",
    "Purchase Orders",
    "Deliveries",
    "Submittals",
    "Advance",
    "Invoices",
    "Compliance",
    "Documents",
    "Messages",
  ],
  contractor: ["Overview", "Scope", "Deliverables", "Time", "Invoices", "Documents", "Messages"],
  crew: [
    "Overview",
    "Offer",
    "Onboarding",
    "Shifts",
    "Timesheets",
    "Travel and Lodging",
    "Per Diem",
    "Credentials",
    "Documents",
    "Messages",
  ],
  staff: [
    "Overview",
    "Offer",
    "Onboarding",
    "Training",
    "Positions",
    "Shifts",
    "Timesheets",
    "Credentials",
    "Documents",
    "Messages",
  ],
  artist: [
    "Overview",
    "Offer",
    "Advance",
    "Rider",
    "Set Times",
    "Hospitality",
    "Guest List",
    "Settlement",
    "Documents",
    "Messages",
  ],
  sponsor: [
    "Overview",
    "Entitlements",
    "Asset Approvals",
    "Activation Schedule",
    "Proof of Performance",
    "Invoices",
    "Documents",
    "Messages",
  ],
};

describe("gateway sitemap", () => {
  it("passes every validator", () => {
    expect(validateSitemap(gateway, { messages })).toEqual([]);
  });

  it("keeps every node within 3 steps of Home (gate 25)", () => {
    expect(Math.max(...indexSitemap(gateway).order.map((e) => e.depth))).toBeLessThanOrEqual(
      MAX_DEPTH,
    );
  });

  it("has the five destinations in order on desktop and phones", () => {
    const ctx = { role: "individual" };
    const expected = ["Home", "Explore", "Work", "Money", "Messages"];
    expect(chromeSlot(gateway, "topBar", ctx).map((n) => labelOf(n.label))).toEqual(expected);
    expect(chromeSlot(gateway, "mobileBottomBar", ctx).map((n) => labelOf(n.label))).toEqual(
      expected,
    );
  });

  it("has the avatar menu, Work tabs and Money pages in order", () => {
    expect(childIds(gateway, "group.avatar").map(label)).toEqual([
      "Profile",
      "Documents",
      "Settings",
      "Switch Org",
      "Help",
      "Sign Out",
    ]);
    expect(childIds(gateway, "work").slice(0, 3).map(label)).toEqual([
      "Upcoming",
      "Engagements",
      "Applications",
    ]);
    expect(childIds(gateway, "money").map(label)).toEqual([
      "Overview",
      "Invoices",
      "Timesheets",
      "Payments",
      "Tax Documents",
    ]);
  });

  it("shows Switch Org only on the platform domain", () => {
    const menu = (conditions: "platform-domain"[]) =>
      chromeSlot(gateway, "avatarMenu", { role: "individual", conditions }).map((n) => n.id);
    expect(menu([])).not.toContain("action.switch-org");
    expect(menu(["platform-domain"])).toContain("action.switch-org");
  });

  it("carries the eight external company settings sections in order", () => {
    expect(childIds(gateway, "settings.company").map(label)).toEqual([
      "Company Profile and Privacy",
      "Team and Account Roles",
      "Service Regions and Capabilities",
      "Insurance and Compliance Documents",
      "Payout and Tax",
      "Representation",
      "Notifications Defaults",
      "Danger Zone",
    ]);
    expect(childIds(gateway, "settings").filter((id) => id !== "settings.company")).toHaveLength(
      15,
    );
  });

  it("declares the 4.5.8 route table", () => {
    const routes = new Set(flattenRoutes(gateway).map((r) => r.route));
    for (const route of [
      "/home",
      "/explore",
      "/explore/{opportunityKey}",
      "/work/upcoming",
      "/work/engagements",
      "/work/applications",
      "/work/engagements/{engagementKey}/overview",
      "/money/invoices",
      "/messages",
      "/messages/{threadKey}",
      "/profile",
      "/documents",
      "/settings/profile",
      "/u/{handle}",
      "/c/{companyHandle}",
      "/advance/{token}",
      "/sign/{token}",
    ]) {
      expect(routes, route).toContain(route);
    }
  });

  it("serves public profiles and token flows without a session", () => {
    expect(guardRoute(gateway, "/u/jordan-lee", { role: null })).toMatchObject({
      status: 200,
      visibility: "public",
    });
    expect(guardRoute(gateway, "/c/northwind-audio", { role: null }).status).toBe(200);
    expect(guardRoute(gateway, "/advance/abcdefghijklmnop1234", { role: null })).toMatchObject({
      status: 200,
      visibility: "token",
    });
    expect(guardRoute(gateway, "/home", { role: null }).status).toBe(404);
  });

  it("tells saved opportunities apart from an opportunity key", () => {
    expect(guardRoute(gateway, "/explore/saved", { role: "individual" })).toMatchObject({
      id: "explore.saved",
    });
    expect(guardRoute(gateway, "/explore/NWL-OPP-12", { role: "individual" })).toMatchObject({
      id: "explore.opportunity",
      params: { opportunityKey: "NWL-OPP-12" },
    });
  });
});

describe("gateway engagement tabs (Section 4.5.8)", () => {
  it.each(Object.entries(TAB_SETS))(
    "%s engagements show their tabs in order",
    (roleType, expected) => {
      const tabs = engagementTabs(gateway, roleType as ExternalRoleType).map((n) =>
        labelOf(n.label),
      );
      expect(tabs).toEqual(expected);
    },
  );

  it("covers all eight role types", () => {
    expect(Object.keys(gateway.engagementTabs?.sets ?? {})).toEqual([...EXTERNAL_ROLE_TYPES]);
  });

  it("gives an Artist Representative the roster and the artist tabs within delegated scopes", () => {
    const none = engagementTabs(gateway, "artist-representative").map((n) => labelOf(n.label));
    expect(none).toEqual(["Roster", "Overview", "Messages"]);
    const scoped = engagementTabs(gateway, "artist-representative", ["advance", "settlement"]).map(
      (n) => labelOf(n.label),
    );
    expect(scoped).toEqual([
      "Roster",
      "Overview",
      "Advance",
      "Rider",
      "Set Times",
      "Hospitality",
      "Guest List",
      "Settlement",
      "Messages",
    ]);
    const all = engagementTabs(gateway, "artist-representative", [
      "offers",
      "advance",
      "settlement",
      "documents",
    ]);
    expect(all.slice(1).map((n) => labelOf(n.label))).toEqual(TAB_SETS.artist);
  });

  it("renders only the tabs of the engagement's own role type", () => {
    const path = "/work/engagements/NWL-E-7/bid";
    expect(guardRoute(gateway, path, { role: "account-owner", roleType: "vendor" }).status).toBe(
      200,
    );
    expect(guardRoute(gateway, path, { role: "account-owner", roleType: "crew" }).status).toBe(404);
    expect(guardRoute(gateway, path, { role: "account-owner" }).status).toBe(404);
    const rider = "/work/engagements/NWL-E-9/rider";
    expect(
      guardRoute(gateway, rider, {
        role: "individual",
        roleType: "artist-representative",
        representationScopes: ["advance"],
      }).status,
    ).toBe(200);
    expect(
      guardRoute(gateway, rider, { role: "individual", roleType: "artist-representative" }).status,
    ).toBe(404);
  });

  it("returns no tabs for an unknown role type", () => {
    expect(engagementTabs(gateway, "unknown" as ExternalRoleType)).toEqual([]);
  });

  it("puts engagement tabs under Work and the engagement in breadcrumbs", () => {
    const crumbs = resolveBreadcrumbs(gateway, "/work/engagements/NWL-E-7/invoices");
    expect(crumbs.map((c) => c.kind)).toEqual(["record", "node"]);
    expect(crumbs[0]).toMatchObject({ value: "NWL-E-7", href: "/work/engagements/NWL-E-7" });
  });
});

describe("gateway account-role visibility", () => {
  const visibleTop = (role: string) =>
    navigationTree(gateway, { role }, ["top-bar"]).flatMap((g) =>
      g.children.map((c) => labelOf(c.label)),
    );

  it("shows Money to Account Finance and not to Account Member", () => {
    expect(visibleTop("account-finance")).toContain("Money");
    expect(visibleTop("account-member")).not.toContain("Money");
    expect(guardRoute(gateway, "/money/invoices", { role: "account-member" }).status).toBe(404);
    expect(guardRoute(gateway, "/money/invoices", { role: "account-finance" }).status).toBe(200);
  });

  it("limits Account Member to assigned engagements", () => {
    expect(guardRoute(gateway, "/work/engagements", { role: "account-member" })).toMatchObject({
      status: 200,
      visibility: "assigned",
    });
  });

  it("opens company settings by account role", () => {
    const company = { conditions: ["company-account" as const] };
    expect(
      guardRoute(gateway, "/settings/company/danger-zone", { role: "account-owner", ...company })
        .status,
    ).toBe(200);
    expect(
      guardRoute(gateway, "/settings/company/danger-zone", { role: "account-admin", ...company })
        .status,
    ).toBe(404);
    expect(
      guardRoute(gateway, "/settings/company/payout-and-tax", {
        role: "account-finance",
        ...company,
      }).status,
    ).toBe(200);
    expect(
      guardRoute(gateway, "/settings/company/payout-and-tax", {
        role: "account-member",
        ...company,
      }).status,
    ).toBe(404);
    expect(
      guardRoute(gateway, "/settings/company/representation", { role: "account-owner" }).status,
    ).toBe(404);
    expect(
      guardRoute(gateway, "/settings/company", { role: "individual", ...company }).status,
    ).toBe(404);
  });

  it("indexes the command menu without key params", () => {
    const ids = commandMenuIndex(gateway, { role: "account-member" }).map((e) => e.id);
    expect(ids).toContain("explore");
    expect(ids).not.toContain("money");
    expect(ids).not.toContain("explore.opportunity");
    expect(treeIds(navigationTree(gateway, { role: "account-member" }))).toContain(
      "action.sign-out",
    );
  });
});
