import { describe, expect, it } from "vitest";
import {
  assertValidSitemap,
  effectiveVisibility,
  getNode,
  hasMessage,
  isNodeVisible,
  moduleOf,
  parseSitemap,
  SitemapLoadError,
  validateSitemap,
  type IssueCode,
  type Sitemap,
} from "../src/index.ts";
import { loadSitemapFile } from "../src/node.ts";
import { loadApp, messages } from "./support.ts";

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("fixture is missing an expected value");
  return value;
}

const catalog = {
  nav: { a: "Alpha", b: "Beta", c: "Gamma", d: "Delta", empty: "" },
};

const ROLES = ["owner", "admin", "manager", "member", "collaborator", "field", "viewer"];
const all = (value: string) => Object.fromEntries(ROLES.map((r) => [r, value]));

/** A minimal valid Atlas sitemap to break one rule at a time. */
function base(): Sitemap {
  return {
    schemaVersion: 1,
    shell: "atlas",
    home: "home",
    params: { org: { type: "slug" } },
    audience: { dimension: "platform-role", roles: [...ROLES] },
    personas: {
      "org-owner": [],
      "org-admin": [],
      producer: ["group.main"],
      "department-head": [],
      "finance-lead": [],
      "production-coordinator": [],
      "field-supervisor": [],
      "field-employee": [],
    },
    nodes: [
      {
        id: "group.main",
        kind: "group",
        label: "nav.a",
        placement: "sidebar",
        visibility: all("full") as never,
        children: [
          { id: "home", kind: "item", label: "nav.b", route: "/{org}/home", level: "org" },
          {
            id: "work",
            kind: "item",
            label: "nav.c",
            route: "/{org}/work",
            level: "org",
            module: "work",
            children: [
              {
                id: "work.list",
                kind: "page",
                label: "nav.d",
                route: "/{org}/work/list",
                list: { views: ["list", "table"], default: "list" },
              },
            ],
          },
        ],
      },
    ],
  };
}

function codes(sitemap: Sitemap): IssueCode[] {
  return validateSitemap(sitemap, { messages: catalog }).map((i) => i.code);
}

function mutate(fn: (s: Sitemap) => void): Sitemap {
  const s = structuredClone(base());
  fn(s);
  return s;
}

const main = (s: Sitemap) => must(s.nodes[0]);
const workNode = (s: Sitemap) => must(main(s).children?.[1]);
const page = (s: Sitemap) => must(workNode(s).children?.[0]);

describe("validateSitemap", () => {
  it("accepts the minimal sitemap", () => {
    expect(codes(base())).toEqual([]);
    expect(() => assertValidSitemap(base(), { messages: catalog })).not.toThrow();
  });

  it.each<[string, (s: Sitemap) => void, IssueCode]>([
    ["duplicate ids", (s) => (page(s).id = "home"), "duplicate-id"],
    ["missing labels", (s) => (page(s).label = "nav.missing"), "label-missing"],
    ["empty labels", (s) => (page(s).label = "nav.empty"), "label-missing"],
    ["pages without routes", (s) => delete page(s).route, "route-missing"],
    ["groups with routes", (s) => (main(s).route = "/{org}/main"), "route-unexpected"],
    ["bad route syntax", (s) => (page(s).route = "/{org}/Work_List"), "route-syntax"],
    ["duplicate routes", (s) => (page(s).route = "/{org}/work"), "route-duplicate"],
    [
      "ambiguous routes",
      (s) => {
        s.params["other"] = { type: "slug" };
        page(s).route = "/{org}/{other}";
      },
      "route-ambiguous",
    ],
    ["undeclared params", (s) => (page(s).route = "/{org}/work/{other}"), "param-undeclared"],
    ["unused params", (s) => (s.params["spare"] = { type: "slug" }), "param-unused"],
    [
      "empty groups",
      (s) =>
        s.nodes.push({
          id: "group.empty",
          kind: "group",
          label: "nav.a",
          placement: "none",
          children: [],
        }),
      "group-empty",
    ],
    ["groups without placement", (s) => delete main(s).placement, "placement"],
    ["placement on items", (s) => (page(s).placement = "sidebar"), "placement"],
    ["unknown references", (s) => (page(s).visibilityFrom = "nowhere"), "reference"],
    ["wrong role list", (s) => (s.audience.roles = ["owner"]), "audience"],
    [
      "partial visibility maps",
      (s) => (page(s).visibility = { owner: "full" }),
      "visibility-roles",
    ],
    ["unresolved visibility", (s) => delete main(s).visibility, "visibility-unresolved"],
    [
      "visible under hidden",
      (s) => {
        workNode(s).visibility = all("hidden") as never;
        page(s).visibility = all("full") as never;
      },
      "visibility-unreachable",
    ],
    [
      "compound values without tagged nodes",
      (s) =>
        (workNode(s).visibility = {
          ...all("full"),
          admin: "full-except-billing-and-legal",
        } as never),
      "compound-visibility",
    ],
    [
      "read and extend without extensions",
      (s) => (workNode(s).visibility = all("read-and-extend") as never),
      "compound-visibility",
    ],
    [
      "default view outside views",
      (s) => (page(s).list = { views: ["list"], default: "board" }),
      "list",
    ],
    [
      "repeated views",
      (s) => (page(s).list = { views: ["list", "list"], default: "list" }),
      "list",
    ],
    ["lists on groups", (s) => (main(s).list = { views: ["list"], default: "list" }), "list"],
    ["missing home", (s) => (s.home = "nowhere"), "home"],
    ["unknown chrome ids", (s) => (s.chrome = { sidebarTop: ["nowhere"] }), "chrome"],
    ["missing personas", (s) => delete must(s.personas)["producer"], "persona"],
    ["unknown personas", (s) => (must(s.personas)["intern"] = []), "persona"],
    ["personas expanding non-groups", (s) => (must(s.personas)["producer"] = ["home"]), "persona"],
    ["sidebar items without level", (s) => delete workNode(s).level, "level"],
    ["levels off the sidebar", (s) => (page(s).level = "org"), "level"],
    ["both items without a twin", (s) => (workNode(s).level = "both"), "twin"],
    ["twins of org items", (s) => (page(s).twin = "home"), "twin"],
  ])("reports %s", (_name, fn, code) => {
    expect(codes(mutate(fn))).toContain(code);
  });

  it("reports nodes deeper than 3 from Home", () => {
    const s = mutate((x) => {
      page(x).children = [
        {
          id: "deep.one",
          kind: "record",
          label: "nav.a",
          route: "/{org}/work/list/one",
          children: [
            { id: "deep.two", kind: "tab", label: "nav.a", route: "/{org}/work/list/one/two" },
          ],
        },
      ];
    });
    expect(codes(s)).toEqual(["depth"]);
  });

  it("refuses Atlas-only values in other shells", () => {
    const gateway = structuredClone(loadApp("gateway"));
    must(must(must(gateway.nodes[0]).children?.[0]).visibility)["individual"] = "own-records";
    expect(validateSitemap(gateway, { messages }).map((i) => i.code)).toContain("visibility-value");
  });

  it("throws with every issue listed", () => {
    expect(() =>
      assertValidSitemap(
        mutate((s) => (s.home = "x")),
        { messages: catalog },
      ),
    ).toThrow(/atlas sitemap has 1 issue\(s\):\n\[home\]/);
  });
});

describe("gateway engagement tab rules", () => {
  const gw = () => structuredClone(loadApp("gateway"));
  const check = (s: Sitemap) => validateSitemap(s, { messages }).map((i) => i.message);

  it("requires tab sets", () => {
    const s = gw();
    delete s.engagementTabs;
    expect(check(s)).toEqual(["gateway needs engagement tab sets (Section 4.5.8)"]);
  });

  it("requires every role type, Overview first, Messages and Documents", () => {
    const s = gw();
    const sets = must(s.engagementTabs).sets;
    delete sets["sponsor"];
    sets["client"] = { tabs: ["engagement.approvals", "engagement.approvals"] };
    s.audience.roleTypes = ["client"];
    const messagesOut = check(s);
    expect(messagesOut).toContain("role type sponsor has no engagement tab set");
    expect(messagesOut).toContain("client engagements must open to Overview");
    expect(messagesOut).toContain('client engagements must carry "engagement.messages"');
    expect(messagesOut).toContain("client repeats a tab");
    expect(messagesOut.some((m) => m.startsWith("gateway role types must be"))).toBe(true);
  });

  it("checks tab ids, unused tabs and delegation coverage", () => {
    const s = gw();
    const sets = must(s.engagementTabs).sets;
    sets["contractor"] = {
      tabs: [
        "engagement.overview",
        "engagement.nowhere",
        "engagement.documents",
        "engagement.messages",
      ],
    };
    const rep = must(sets["artist-representative"]);
    if ("scopes" in rep) delete rep.scopes["settlement"];
    const out = check(s);
    expect(out).toContain('contractor names "engagement.nowhere", which is not an engagement tab');
    expect(out.some((m) => m.startsWith('engagement tab "engagement.scope" is in no'))).toBe(true);
    expect(out.some((m) => m.includes("missing: engagement.settlement"))).toBe(true);
  });

  it("requires a container with tabs", () => {
    const s = gw();
    must(s.engagementTabs).container = "home";
    expect(check(s)).toContain('container "home" has no tabs');
  });
});

describe("compass content rules", () => {
  const cp = () => structuredClone(loadApp("compass"));
  const check = (s: Sitemap) => validateSitemap(s, { messages }).map((i) => i.message);

  it("requires a scan container and a profile per audience", () => {
    const s = cp();
    delete s.scanContainer;
    delete must(s.contentProfiles)["sponsor"];
    must(s.contentProfiles)["intern"] = { today: ["shifts"], scanModes: [] };
    const out = check(s);
    expect(out).toContain("compass needs a scan container with one child per scan mode");
    expect(out).toContain("audience sponsor has no role-aware content profile");
    expect(out).toContain("unknown audience intern");
  });

  it("keeps scan profiles and scan mode visibility in step", () => {
    const s = cp();
    must(must(s.contentProfiles)["client"]).scanModes.push({ mode: "lookup", scope: "all" });
    must(must(s.contentProfiles)["client"]).today.push("nowhere");
    must(s.contentBlocks).push({ id: "extra", label: "nav.compass.nowhere" });
    const out = check(s);
    expect(out.some((m) => m.startsWith("scan mode lookup is hidden for client"))).toBe(true);
    expect(out).toContain('client shows unknown block "nowhere"');
    expect(out.some((m) => m.startsWith('content block "extra"'))).toBe(true);
  });

  it("requires a node per scan mode and deep links that match routes", () => {
    const s = cp();
    const scan = must(must(s.nodes[0]).children?.find((n) => n.id === "scan"));
    scan.children = must(scan.children).filter((c) => c.id !== "scan.lookup");
    s.deepLinks = [
      { pattern: "compass://r/{recordKey}/{other}", node: "record" },
      { pattern: "compass://x", node: "group.routes" },
    ];
    const out = check(s);
    expect(out).toContain("scan mode lookup has no node");
    expect(out.some((m) => m.includes("params differ"))).toBe(true);
    expect(out.some((m) => m.includes("has no route"))).toBe(true);
  });
});

describe("loading", () => {
  it("parses YAML and reports syntax and schema errors with the source", () => {
    expect(() => parseSitemap("nodes: [", "broken.yaml")).toThrow(SitemapLoadError);
    expect(() => parseSitemap("a: 1\na: 2\n", "dupe.yaml")).toThrow(/dupe\.yaml: invalid YAML/);
    expect(() => parseSitemap("schemaVersion: 2\n", "old.yaml")).toThrow(
      /old\.yaml: schema mismatch/,
    );
    try {
      parseSitemap("schemaVersion: 1\n");
    } catch (error) {
      expect(error).toBeInstanceOf(SitemapLoadError);
      expect((error as SitemapLoadError).source).toBe("sitemap.yaml");
    }
  });

  it("loads files by path or URL", () => {
    const url = new URL("../../../apps/compass/ia/sitemap.yaml", import.meta.url);
    expect(loadSitemapFile(url).shell).toBe("compass");
    expect(loadSitemapFile(url.pathname).home).toBe("today");
  });
});

describe("lookups", () => {
  it("resolves messages, nodes and modules", () => {
    expect(hasMessage(catalog, "nav.a")).toBe(true);
    expect(hasMessage(catalog, "nav")).toBe(false);
    expect(hasMessage(catalog, "nav.a.b")).toBe(false);
    const atlas = loadApp("atlas");
    expect(() => getNode(atlas, "nowhere")).toThrow(/unknown sitemap node "nowhere"/);
    expect(moduleOf(atlas, "project.budget")).toBe("finance");
    expect(moduleOf(atlas, "finance.budgets")).toBe("finance");
    expect(moduleOf(atlas, "home")).toBeUndefined();
    expect(moduleOf(atlas, "nowhere")).toBeUndefined();
    expect(effectiveVisibility(atlas, "nowhere", "owner")).toBeUndefined();
    expect(isNodeVisible(atlas, "nowhere", { role: "owner" })).toBe(false);
    expect(isNodeVisible(atlas, "group.chrome", { role: null })).toBe(false);
    expect(isNodeVisible(atlas, "action.search", { role: "viewer" })).toBe(true);
    expect(isNodeVisible(atlas, "action.search", { role: null })).toBe(false);
  });

  it("returns undefined for a cycle or a missing reference", () => {
    const s = mutate((x) => {
      page(x).visibilityFrom = "work.list";
    });
    expect(effectiveVisibility(s, "work.list", "owner")).toBeUndefined();
    const t = mutate((x) => {
      page(x).visibilityFrom = "nowhere";
    });
    expect(effectiveVisibility(t, "work.list", "owner")).toBeUndefined();
    const u = mutate((x) => {
      main(x).visibility = { owner: "full" } as never;
    });
    expect(effectiveVisibility(u, "home", "viewer")).toBeUndefined();
  });

  it("uses the source catalog in the real sitemaps", () => {
    expect(hasMessage(messages, "nav.atlas.items.home")).toBe(true);
  });
});
