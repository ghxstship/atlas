import { describe, expect, it } from "vitest";
import {
  ATLAS_ROLES,
  chromeSlot,
  commandMenuIndex,
  declaredVisibility,
  effectiveVisibility,
  expandedGroups,
  flattenRoutes,
  guardRoute,
  indexSitemap,
  LIST_QUERY_PARAMS,
  MAX_DEPTH,
  navigationTree,
  resolveBreadcrumbs,
  validateServedBy,
  validateSitemap,
  visibleRoutes,
  type AtlasRole,
  type Visibility,
} from "../src/index.ts";
import { childIds, labelOf, loadApp, messages, treeIds } from "./support.ts";

const atlas = loadApp("atlas");
const gateway = loadApp("gateway");
const labels = (ids: string[]) =>
  ids.map((id) => labelOf(indexSitemap(atlas).byId.get(id)?.node.label ?? ""));

describe("atlas sitemap", () => {
  it("passes every validator", () => {
    expect(validateSitemap(atlas, { messages })).toEqual([]);
  });

  it("serves its token routes from Gateway", () => {
    expect(validateServedBy(atlas, [gateway])).toEqual([]);
    expect(validateServedBy(atlas, [])).toHaveLength(2);
  });

  it("keeps every node within 3 steps of Home (gate 25)", () => {
    const depths = indexSitemap(atlas).order.map((e) => e.depth);
    expect(Math.max(...depths)).toBe(MAX_DEPTH);
  });

  it("lists sidebar groups and items in the 4.5.2 order with their levels", () => {
    const groups = atlas.nodes.filter((n) => n.placement === "sidebar" || n.placement === "footer");
    expect(groups.map((g) => labelOf(g.label))).toEqual([
      "Workspace",
      "Production",
      "Operations",
      "People",
      "Commercial",
      "Knowledge",
      "Footer Navigation",
    ]);
    const items = groups.flatMap((g) => g.children ?? []);
    expect(items.map((i) => [labelOf(i.label), i.level])).toEqual([
      ["Home", "org"],
      ["Inbox", "org"],
      ["My Work", "org"],
      ["Projects", "org"],
      ["Schedule", "both"],
      ["Work", "both"],
      ["Show", "both"],
      ["Advancing", "both"],
      ["Places", "org"],
      ["Logistics", "both"],
      ["Hospitality", "both"],
      ["Assets", "both"],
      ["Credentials", "both"],
      ["Safety", "both"],
      ["People", "org"],
      ["Opportunities", "both"],
      ["Crew", "both"],
      ["Finance", "both"],
      ["Procurement", "both"],
      ["Vendors", "org"],
      ["Knowledge", "org"],
      ["Reports", "both"],
      ["Canon", "org"],
      ["Activity", "org"],
      ["Settings", "org"],
    ]);
  });

  it("lists project tabs in the 4.5.4 order, grouped by act, landing on Overview", () => {
    const acts = childIds(atlas, "project");
    expect(labels(acts)).toEqual(["Plan", "Build", "Show"]);
    const tabs = acts.flatMap((a) => childIds(atlas, a));
    expect(labels(tabs)).toEqual([
      "Overview",
      "Scope",
      "Gates",
      "Schedule",
      "Work",
      "Show",
      "Advancing",
      "Logistics",
      "Hospitality",
      "Assets",
      "Crew",
      "Engagements",
      "Credentials",
      "Safety",
      "Budget",
      "Procurement",
      "Documents",
      "Reports",
      "Activity",
      "Settings",
    ]);
    expect(tabs[0]).toBe("project.overview");
  });

  it("lists module pages in the 4.5.5 order", () => {
    const pages = (id: string) => labels(childIds(atlas, id).filter((c) => c !== "project"));
    expect(pages("home")).toEqual(["Today", "Gate Readiness Across Projects", "Alerts", "Recent"]);
    expect(pages("projects")).toEqual([
      "All Projects",
      "By Phase",
      "Portfolio Timeline",
      "Templates",
    ]);
    expect(pages("crew")).toEqual([
      "Schedule",
      "Shifts",
      "Swaps",
      "Time Entries",
      "Timesheets",
      "Rate Cards",
      "Pay Periods",
      "Payroll Exports",
      "Time Off",
    ]);
    expect(pages("finance")).toHaveLength(10);
    expect(pages("safety")).toHaveLength(7);
    expect(pages("opportunities")).toHaveLength(8);
    expect(pages("canon")).toHaveLength(10);
    expect(pages("reports").at(-1)).toBe("Report Builder");
    expect(pages("activity")).toEqual(["Org Activity Feed", "Audit Log"]);
  });

  it("carries the 42 organization and 15 personal settings sections in order", () => {
    const org = labels(childIds(atlas, "settings"));
    expect(org).toHaveLength(42);
    expect(org.slice(0, 4)).toEqual([
      "Organization Profile",
      "General",
      "Legal Entities and Fiscal",
      "Members",
    ]);
    expect(org.slice(35, 42)).toEqual([
      "Billing and Plan",
      "Partner",
      "Usage",
      "Data and Privacy",
      "Audit Log",
      "Legal",
      "Danger Zone",
    ]);
    const personal = labels(childIds(atlas, "me"));
    expect(personal).toHaveLength(15);
    expect(personal[0]).toBe("Profile");
    expect(personal[14]).toBe("Developer");
  });

  it("declares the 4.5.3 route table", () => {
    const routes = new Set(flattenRoutes(atlas).map((r) => r.route));
    for (const route of [
      "/{org}/home",
      "/{org}/inbox",
      "/{org}/my-work",
      "/{org}/projects",
      "/{org}/p/{projectKey}/overview",
      "/{org}/schedule/timeline",
      "/{org}/r/{recordKey}",
      "/{org}/views/{viewId}",
      "/{org}/settings/members",
      "/{org}/me/profile",
      "/advance/{token}",
      "/sign/{token}",
      "/legal/{document}",
      "/partner/{partnerSlug}/client-orgs",
      "/{org}/objects/{objectKey}",
      "/{org}/import",
      "/{org}/reports/builder",
      "/ical/{feedToken}.ics",
    ]) {
      expect(routes, route).toContain(route);
    }
    expect(atlas.globalQuery).toEqual({ peek: "recordKey" });
  });

  it("gives every list route the view query parameters", () => {
    const lists = flattenRoutes(atlas).filter((r) => r.views);
    expect(lists.length).toBeGreaterThan(100);
    for (const r of lists) {
      expect(r.query).toEqual(LIST_QUERY_PARAMS);
      expect(r.views).toContain(r.defaultView);
    }
    const plain = flattenRoutes(atlas).find((r) => r.id === "project.overview");
    expect(plain?.query).toEqual([]);
  });

  it("expands the role-default sidebar groups per persona", () => {
    expect(expandedGroups(atlas, "producer")).toEqual(["group.production"]);
    expect(expandedGroups(atlas, "finance-lead")).toEqual(["group.commercial"]);
    expect(expandedGroups(atlas, "production-coordinator")).toEqual(["group.operations"]);
    expect(expandedGroups(atlas, "department-head")).toEqual([
      "group.production",
      "group.operations",
    ]);
    expect(expandedGroups(atlas, "field-supervisor")).toEqual(["group.operations", "group.people"]);
    expect(expandedGroups(atlas, "org-owner")).toEqual([]);
    expect(expandedGroups(atlas, "nobody")).toEqual([]);
  });

  it("resolves the chrome slots", () => {
    const ctx = { role: "member" };
    expect(chromeSlot(atlas, "sidebarTop", ctx).map((n) => n.id)).toEqual([
      "action.search",
      "home",
      "inbox",
      "my-work",
    ]);
    expect(chromeSlot(atlas, "mobileBottomBar", ctx).map((n) => labelOf(n.label))).toEqual([
      "Home",
      "Inbox",
      "Search",
      "My Work",
      "Menu",
    ]);
    expect(chromeSlot(atlas, "missing", ctx)).toEqual([]);
  });
});

/** Section 4.5.9, row by row, in the column order Owner, Admin, Manager, Member, Collaborator, Field, Viewer. */
const ROLE_TABLE: ReadonlyArray<{
  row: string;
  node: string;
  route: string;
  values: readonly Visibility[];
}> = [
  {
    row: "Workspace",
    node: "group.workspace",
    route: "/acme/home",
    values: ["full", "full", "full", "full", "full", "full", "read"],
  },
  {
    row: "Production",
    node: "group.production",
    route: "/acme/schedule/timeline",
    values: ["full", "full", "full", "full", "assigned", "assigned", "read"],
  },
  {
    row: "Operations",
    node: "group.operations",
    route: "/acme/logistics/shipments",
    values: ["full", "full", "full", "full", "assigned", "assigned", "read"],
  },
  {
    row: "People",
    node: "people",
    route: "/acme/people/directory",
    values: ["full", "full", "full", "read", "hidden", "own-profile", "hidden"],
  },
  {
    row: "Opportunities",
    node: "opportunities",
    route: "/acme/opportunities/postings",
    values: ["full", "full", "full", "read", "hidden", "hidden", "read"],
  },
  {
    row: "Crew",
    node: "crew",
    route: "/acme/crew/shifts",
    values: ["full", "full", "full", "read", "hidden", "own-records", "hidden"],
  },
  {
    row: "Commercial",
    node: "group.commercial",
    route: "/acme/finance/budgets",
    values: ["full", "full", "full", "read", "hidden", "hidden", "hidden"],
  },
  {
    row: "Knowledge",
    node: "knowledge",
    route: "/acme/knowledge/sops",
    values: ["full", "full", "full", "full", "read", "read", "read"],
  },
  {
    row: "Reports",
    node: "reports",
    route: "/acme/reports/labor",
    values: ["full", "full", "full", "read", "hidden", "hidden", "read"],
  },
  {
    row: "Canon",
    node: "canon",
    route: "/acme/canon/departments",
    values: ["read-and-extend", "read-and-extend", "read", "read", "read", "hidden", "read"],
  },
  {
    row: "Activity feed",
    node: "activity.feed",
    route: "/acme/activity/feed",
    values: ["full", "full", "full", "full", "assigned", "hidden", "read"],
  },
  {
    row: "Audit log",
    node: "activity.audit-log",
    route: "/acme/activity/audit-log",
    values: ["full", "full", "hidden", "hidden", "hidden", "hidden", "hidden"],
  },
  {
    row: "Org settings",
    node: "settings",
    route: "/acme/settings/general",
    values: [
      "full",
      "full-except-billing-and-legal",
      "hidden",
      "hidden",
      "hidden",
      "hidden",
      "hidden",
    ],
  },
  {
    row: "Personal settings",
    node: "me",
    route: "/acme/me/profile",
    values: ["full", "full", "full", "full", "full", "full", "full"],
  },
];

const SHELL_PLACEMENTS = ["sidebar", "footer", "account-menu"];
const cells = ROLE_TABLE.flatMap((r) =>
  ATLAS_ROLES.map((role, i) => ({ ...r, role, expected: r.values[i] as Visibility })),
);

describe("atlas role visibility (Section 4.5.9)", () => {
  it("covers all 98 cells", () => {
    expect(cells).toHaveLength(98);
  });

  it.each(cells)("$row for $role is $expected", ({ node, route, role, expected }) => {
    const ctx = { role, conditions: [] };
    expect(declaredVisibility(atlas, node, role)).toBe(expected);
    const visible = expected !== "hidden";

    const sidebar = treeIds(navigationTree(atlas, ctx, SHELL_PLACEMENTS));
    expect(sidebar.includes(node)).toBe(visible);

    const owned = guardRoute(atlas, route, { role: "owner" });
    expect(owned.status).toBe(200);
    const pageId = owned.status === 200 ? owned.id : "";
    const menu = commandMenuIndex(atlas, { ...ctx, knownParams: ["org"] }).map((e) => e.id);
    expect(menu.includes(pageId)).toBe(visible);

    const guarded = guardRoute(atlas, route, ctx);
    expect(guarded.status).toBe(visible ? 200 : 404);
  });

  it("hides Billing and Legal from Admin and nothing else in Org settings", () => {
    const admin = { role: "admin" as AtlasRole };
    expect(guardRoute(atlas, "/acme/settings/billing-and-plan", admin).status).toBe(404);
    expect(guardRoute(atlas, "/acme/settings/legal", admin).status).toBe(404);
    expect(guardRoute(atlas, "/acme/settings/danger-zone", admin).status).toBe(200);
    expect(effectiveVisibility(atlas, "settings.members", "admin")).toBe("full");
    expect(guardRoute(atlas, "/acme/settings/billing-and-plan", { role: "owner" }).status).toBe(
      200,
    );
  });

  it("shows the Partner settings section only to partner orgs", () => {
    expect(guardRoute(atlas, "/acme/settings/partner", { role: "owner" }).status).toBe(404);
    expect(
      guardRoute(atlas, "/acme/settings/partner", { role: "owner", conditions: ["partner-org"] })
        .status,
    ).toBe(200);
  });

  it("returns 404 for every Atlas route to external users", () => {
    for (const r of flattenRoutes(atlas).filter((x) => x.auth === "session")) {
      const path = r.route
        .replace("{org}", "acme")
        .replace("{projectKey}", "NWL")
        .replace("{recordKey}", "NWL-142")
        .replace("{viewId}", "0190a2b4-6c1d-7e3f-8a9b-0c1d2e3f4a5b")
        .replace("{objectKey}", "stage-plots")
        .replace("{partnerSlug}", "northwind");
      expect(guardRoute(atlas, path, { role: null }).status, path).toBe(404);
    }
    expect(guardRoute(atlas, "/legal/terms", { role: null })).toMatchObject({
      status: 200,
      visibility: "public",
    });
    expect(guardRoute(atlas, "/ical/abcdefghijklmnop1234.ics", { role: null })).toMatchObject({
      status: 200,
      visibility: "token",
    });
  });

  it("applies twins to project tabs", () => {
    expect(guardRoute(atlas, "/acme/p/NWL/budget", { role: "collaborator" }).status).toBe(404);
    expect(guardRoute(atlas, "/acme/p/NWL/schedule", { role: "collaborator" })).toMatchObject({
      status: 200,
      visibility: "assigned",
    });
    expect(guardRoute(atlas, "/acme/p/NWL/crew", { role: "field" })).toMatchObject({
      status: 200,
      visibility: "own-records",
    });
    expect(guardRoute(atlas, "/acme/p/NWL/documents", { role: "viewer" })).toMatchObject({
      status: 200,
      visibility: "read",
    });
  });

  it("drops a module that an Org Admin turned off from routes and the command menu", () => {
    const ctx = { role: "owner", disabledModules: ["safety"] };
    expect(guardRoute(atlas, "/acme/safety/permits", ctx).status).toBe(404);
    expect(guardRoute(atlas, "/acme/p/NWL/safety", ctx).status).toBe(404);
    expect(
      commandMenuIndex(atlas, { ...ctx, knownParams: ["org"] }).some((e) => e.id === "safety"),
    ).toBe(false);
    expect(visibleRoutes(atlas, ctx).some((r) => r.id.startsWith("safety"))).toBe(false);
  });

  it("offers project tabs in the command menu only inside a project", () => {
    const outside = commandMenuIndex(atlas, { role: "owner", knownParams: ["org"] });
    const inside = commandMenuIndex(atlas, { role: "owner", knownParams: ["org", "projectKey"] });
    expect(outside.some((e) => e.id === "project.budget")).toBe(false);
    const budget = inside.find((e) => e.id === "project.budget");
    expect(budget?.context).toEqual(["nav.atlas.items.projects", "nav.atlas.routes.project"]);
  });
});

describe("atlas breadcrumbs", () => {
  it("follows Org, Workspace, Project, Scope node, Module", () => {
    const crumbs = resolveBreadcrumbs(atlas, "/acme/p/NWL/budget?view=table", {
      workspace: "Miami",
      scope: "Main Stage",
    });
    expect(crumbs.map((c) => c.kind)).toEqual(["org", "workspace", "project", "scope", "node"]);
    expect(crumbs[2]).toMatchObject({ value: "NWL", href: "/acme/p/NWL" });
    expect(crumbs[4]).toMatchObject({ id: "project.budget", href: "/acme/p/NWL/budget" });
  });

  it("shows module then page for org-level pages", () => {
    const crumbs = resolveBreadcrumbs(atlas, "/acme/finance/budgets/", { scope: "Main Stage" });
    expect(crumbs.map((c) => (c.kind === "node" ? c.id : c.kind))).toEqual([
      "org",
      "scope",
      "finance",
      "finance.budgets",
    ]);
  });

  it("ends with the record for record pages", () => {
    const crumbs = resolveBreadcrumbs(atlas, "/acme/r/NWL-142");
    expect(crumbs).toEqual([
      { kind: "org", value: "acme", label: "nav.breadcrumb.org" },
      {
        kind: "record",
        value: "NWL-142",
        label: "nav.atlas.routes.record",
        href: "/acme/r/NWL-142",
      },
    ]);
  });

  it("is empty for an unknown path", () => {
    expect(resolveBreadcrumbs(atlas, "/acme/nowhere/at-all/really")).toEqual([]);
  });
});
