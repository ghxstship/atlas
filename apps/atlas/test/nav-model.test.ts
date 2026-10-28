import { describe, expect, it } from "vitest";
import { ATLAS_ROLES, type Sitemap, type SitemapNode } from "@xos/ia";
import { sitemap } from "../ia/sitemap.generated";
import {
  buildShellNav,
  NAV_ICONS,
  type RecentProjectModel,
  recentProjectLinks,
  ROLE_PERSONA,
} from "../lib/shell/nav-model";

const t = (key: string) => key;
const build = (role: (typeof ATLAS_ROLES)[number], extra: { disabledModules?: string[] } = {}) =>
  buildShellNav(sitemap, {
    nav: { role, conditions: ["desktop"], ...extra },
    role,
    params: { org: "acme" },
    t,
  });

describe("shell navigation model (Section 4.5.2)", () => {
  it("puts Home, Inbox and My Work at the top and Projects pinned", () => {
    const nav = build("owner");
    expect(nav.top.map((l) => l.id)).toEqual(["home", "inbox", "my-work"]);
    expect(nav.pinned.map((l) => l.id)).toEqual(["projects"]);
    expect(nav.top[0]?.href).toBe("/acme/home");
  });

  it("lists module groups in sitemap order without repeating the pinned items", () => {
    const nav = build("owner");
    expect(nav.groups.map((g) => g.id)).toEqual([
      "group.production",
      "group.operations",
      "group.people",
      "group.commercial",
      "group.knowledge",
    ]);
    expect(nav.groups[0]?.items.map((i) => i.id)).toEqual([
      "schedule",
      "work",
      "show",
      "advancing",
    ]);
    expect(nav.footer.map((l) => l.id)).toEqual(["activity", "settings"]);
    expect(nav.account?.href).toBe("/acme/me");
  });

  it("expands the groups the role's persona uses most", () => {
    expect(ROLE_PERSONA.manager).toBe("producer");
    expect(
      build("manager")
        .groups.filter((g) => g.expanded)
        .map((g) => g.id),
    ).toEqual(["group.production"]);
    expect(
      build("member")
        .groups.filter((g) => g.expanded)
        .map((g) => g.id),
    ).toEqual(["group.production", "group.operations"]);
    expect(build("owner").groups.some((g) => g.expanded)).toBe(false);
  });

  it("hides what the role may not see (Section 4.5.9)", () => {
    const viewer = build("viewer");
    expect(viewer.groups.map((g) => g.id)).not.toContain("group.commercial");
    expect(viewer.footer.map((l) => l.id)).toEqual(["activity"]);
    const field = build("field");
    expect(field.footer).toEqual([]);
    expect(field.commands.flatMap((g) => g.items).some((i) => i.href.includes("/settings"))).toBe(
      false,
    );
  });

  it("drops modules an org turned off from the sidebar and the command menu", () => {
    const nav = build("owner", { disabledModules: ["finance"] });
    expect(nav.groups.flatMap((g) => g.items).map((i) => i.id)).not.toContain("finance");
    expect(nav.commands.flatMap((g) => g.items).some((i) => i.href.includes("/finance"))).toBe(
      false,
    );
  });

  it("builds the phone bottom bar: Home, Inbox, Search, My Work, Menu", () => {
    expect(build("member").bottomBar.map((b) => b.action ?? b.id)).toEqual([
      "home",
      "inbox",
      "search",
      "my-work",
      "menu",
    ]);
  });

  it("indexes every page the viewer may open in the command menu, grouped by module", () => {
    const nav = build("owner");
    const finance = nav.commands.find((g) => g.label === "nav.atlas.items.finance");
    expect(finance?.items.map((i) => i.href)).toContain("/acme/finance/budgets");
    const hrefs = nav.commands.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs.every((h) => h.startsWith("/acme/"))).toBe(true);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(Object.keys(NAV_ICONS)).toContain("finance");
  });
});

describe("recent projects under Projects (Section 4.5.2)", () => {
  const opened: RecentProjectModel[] = [
    { key: "NWX", name: "Northwind Winter Gala" },
    { key: "NWL", name: "Northwind Summer Series" },
    { key: "NWX", name: "Northwind Winter Gala" },
    { key: "HLP", name: "Harbor Lights Pier Nights" },
    { key: "BAY", name: "Bayfront Countdown" },
    { key: "KEY", name: "Key Biscayne Regatta" },
    { key: "SUN", name: "Sunset Sessions" },
  ];
  const projectsEntry = (nav: ReturnType<typeof buildShellNav>) =>
    nav.pinned.find((l) => l.id === "projects");
  const withRecent = (map: Sitemap, role: (typeof ATLAS_ROLES)[number] | null) =>
    buildShellNav(map, {
      nav: { role, conditions: ["desktop"] },
      role,
      params: { org: "acme" },
      t,
      recentProjects: opened,
    });
  /** The sitemap with one node hidden from one role. */
  const hiding = (id: string, role: string): Sitemap => {
    const hide = (node: SitemapNode): SitemapNode =>
      node.id === id
        ? {
            ...node,
            visibility: {
              ...Object.fromEntries(ATLAS_ROLES.map((r) => [r, "full" as const])),
              [role]: "hidden" as const,
            },
          }
        : { ...node, ...(node.children ? { children: node.children.map(hide) } : {}) };
    return { ...sitemap, nodes: sitemap.nodes.map(hide) };
  };

  it("lists the five most recent projects, once each and newest first, then All Projects", () => {
    const children = projectsEntry(withRecent(sitemap, "member"))?.children ?? [];
    expect(children.map((l) => l.label)).toEqual([
      "Northwind Winter Gala",
      "Northwind Summer Series",
      "Harbor Lights Pier Nights",
      "Bayfront Countdown",
      "Key Biscayne Regatta",
      "nav.atlas.pages.projects.all",
    ]);
    expect(children.map((l) => l.href)).toEqual([
      "/acme/p/NWX",
      "/acme/p/NWL",
      "/acme/p/HLP",
      "/acme/p/BAY",
      "/acme/p/KEY",
      "/acme/projects/all",
    ]);
    expect(new Set(children.map((l) => l.id)).size).toBe(children.length);
  });

  it("lists nothing under Projects before the person opens a project", () => {
    expect(projectsEntry(build("member"))?.children).toBeUndefined();
    expect(
      recentProjectLinks(sitemap, [], { nav: { role: "member" }, params: { org: "acme" }, t }),
    ).toEqual([]);
  });

  it("respects what the role may open", () => {
    // Without project pages there is nothing to list; Projects itself stays.
    const noProjectPages = withRecent(hiding("project", "viewer"), "viewer");
    expect(projectsEntry(noProjectPages)).toBeDefined();
    expect(projectsEntry(noProjectPages)?.children).toBeUndefined();
    expect(projectsEntry(withRecent(hiding("project", "viewer"), "member"))?.children).toHaveLength(
      6,
    );
    // Without the All Projects page the recent projects stand alone.
    const noAll = projectsEntry(withRecent(hiding("projects.all", "field"), "field"))?.children;
    expect(noAll?.map((l) => l.href)).not.toContain("/acme/projects/all");
    expect(noAll).toHaveLength(5);
    // Someone with no role in the org sees no Projects entry at all.
    expect(withRecent(sitemap, null).pinned).toEqual([]);
  });
});
