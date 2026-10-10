import { describe, expect, it } from "vitest";
import type { ATLAS_ROLES } from "@xos/ia";
import { sitemap } from "../ia/sitemap.generated";
import { buildShellNav, NAV_ICONS, ROLE_PERSONA } from "../lib/shell/nav-model";

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
