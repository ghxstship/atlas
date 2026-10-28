import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getMessages } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import {
  allExportSources,
  exportEntryFor,
  exportSourceFor,
  planExport,
  EXPORT_SOURCES,
  NOT_EXPORTED,
} from "../lib/views/export-sources";
import { collectionKeyFor } from "../lib/views/query";

/**
 * Export from every collection (A102, Section 4.6.4): every page whose import graph renders the one view
 * switcher (components/views/collection-views.tsx) has an export source, every exported column has a header
 * in both launch locales, and the plan of an export carries the page's own filters, its scope, the URL's
 * filters and its search.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const switcher = join(root, "components/views/collection-views.tsx");

function pages(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) pages(path, out);
    else if (name === "page.tsx") out.push(path);
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? join(root, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null;
  if (base === null) return null;
  for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const path = base + ext;
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

const rendersSwitcher = new Map<string, boolean>();
function reachesSwitcher(file: string, seen = new Set<string>()): boolean {
  const known = rendersSwitcher.get(file);
  if (known !== undefined) return known;
  if (file === switcher) return true;
  if (seen.has(file)) return false;
  seen.add(file);
  const source = readFileSync(file, "utf8");
  const found = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].some((m) => {
    const next = resolveImport(file, m[1] ?? "");
    return next !== null && reachesSwitcher(next, seen);
  });
  rendersSwitcher.set(file, found);
  return found;
}

/** The URL of a route with sample params: what collectionKeyFor reads in the browser. */
function sampleUrl(route: string): string {
  return `/${route
    .replace("[org]", "acme")
    .replace("[projectKey]", "NWL")
    .replace("[objectKey]", "guest-list")}`;
}

function flatten(value: unknown, prefix = "", out = new Map<string, string>()) {
  if (typeof value === "string") out.set(prefix, value);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

describe("export sources (Section 4.6.4)", () => {
  const collections = pages(join(root, "app/[org]"))
    .filter((page) => reachesSwitcher(page))
    .map((page) => page.slice(join(root, "app/").length).replace(/\/page\.tsx$/, ""));

  it("finds the collections that render the view switcher", () => {
    expect(collections.length).toBeGreaterThan(130);
    expect(collections).toContain("[org]/crew/rate-cards");
    expect(collections).toContain("[org]/p/[projectKey]/procurement");
  });

  it("gives every one of them an export source", () => {
    const missing = collections.filter((route) => {
      const key = collectionKeyFor(sampleUrl(route));
      return exportEntryFor(key) === null && !(key !== null && key in NOT_EXPORTED);
    });
    expect(missing).toEqual([]);
  });

  it("names no collection that no page renders", () => {
    const keys = new Set(collections.map((route) => collectionKeyFor(sampleUrl(route))));
    const stale = Object.keys(EXPORT_SOURCES).filter(
      (key) => !keys.has(key) && !(key === "objects/*" && keys.has("objects/guest_list")),
    );
    expect(stale).toEqual([]);
  });

  it("gives every exported column a header in en-US and es-US", () => {
    for (const locale of ["en-US", "es-US"] as const) {
      const catalog = flatten(getMessages(locale));
      const missing = [...new Set(allExportSources().flatMap((s) => s.columns))].filter(
        (column) => !catalog.get(`views.export.columns.${column}`),
      );
      expect(missing, locale).toEqual([]);
    }
  });

  it("reads one relation per source and never the medical encounter tables", () => {
    for (const source of allExportSources()) {
      expect(source.relation).toMatch(/^(app|xpms)\.[a-z][a-z0-9_]*$/);
      expect(source.relation).not.toMatch(/medical/);
      expect(source.columns.length).toBeGreaterThan(0);
      expect(new Set(source.columns).size, source.relation).toBe(source.columns.length);
    }
  });

  it("exports the masked rate of a rate card, which classifies Restricted in the database", () => {
    const rates = exportSourceFor("crew/rate_cards", new URLSearchParams());
    expect(rates?.relation).toBe("app.rate_card_lines_masked");
    expect(rates?.columns).toContain("rate_minor");
  });
});

describe("the plan of an export", () => {
  it("follows the section a project tab shows, and its default", () => {
    const procurement = (section?: string) =>
      exportSourceFor("project/procurement", new URLSearchParams(section ? { section } : {}))
        ?.relation;
    expect(procurement()).toBe("app.purchase_orders");
    expect(procurement("rfqs")).toBe("app.rfqs");
    expect(procurement("nonsense")).toBe("app.purchase_orders");
  });

  it("carries the URL's filters, lists, project keys and search, and leaves the rest out", () => {
    const records = exportSourceFor("work/all_records", new URLSearchParams());
    if (!records) throw new Error("no records source");
    const plan = planExport(
      records,
      "/acme/work/all-records",
      new URLSearchParams({
        view: "table",
        project: "NWL",
        kind: "Task,Milestone",
        state: "Active",
        owner: "someone",
        q: "  truss  ",
        peek: "abc",
      }),
    );
    expect(plan).toEqual({
      projectKey: null,
      objectKey: null,
      filters: [
        { operator: "is_null", column: "archived_at" },
        { operator: "eq", column: "project_id", value: "NWL", resolve: "project" },
        { operator: "in", column: "record_kind", value: "Task,Milestone" },
        { operator: "eq", column: "record_state", value: "Active" },
        { operator: "search", value: "truss" },
      ],
    });
  });

  it("applies the page's own filters and scopes a project tab or a custom object to its path", () => {
    const milestones = exportSourceFor("schedule/milestones", new URLSearchParams());
    if (!milestones) throw new Error("no milestones source");
    expect(
      planExport(milestones, "/acme/schedule/milestones", new URLSearchParams())?.filters,
    ).toEqual([{ operator: "eq", column: "record_kind", value: "Milestone" }]);
    const work = exportSourceFor("project/work", new URLSearchParams());
    if (!work) throw new Error("no project work source");
    expect(planExport(work, "/acme/p/NWL/work", new URLSearchParams())?.projectKey).toBe("NWL");
    expect(planExport(work, "/acme/work/all-records", new URLSearchParams())).toBeNull();
    const objects = exportSourceFor(
      collectionKeyFor("/acme/objects/guest-list"),
      new URLSearchParams(),
    );
    if (!objects) throw new Error("no custom object source");
    expect(planExport(objects, "/acme/objects/guest-list", new URLSearchParams())?.objectKey).toBe(
      "guest-list",
    );
  });

  it("scopes a project's Activity, Overview and receipts to the project, as the page shows them", () => {
    const plan = (key: string, path: string, query: Record<string, string> = {}) => {
      const search = new URLSearchParams(query);
      const source = exportSourceFor(key, search);
      if (!source) throw new Error(`no source for ${key}`);
      return { source, plan: planExport(source, path, search) };
    };
    for (const [key, path, query] of [
      ["project/activity", "/x/p/NWL/activity", {}],
      ["project/overview", "/x/p/NWL/overview", {}],
      ["project/procurement", "/x/p/NWL/procurement", { section: "receipts" }],
    ] as const) {
      const { source, plan: scoped } = plan(key, path, query);
      expect(source.columns, key).toContain("project_id");
      expect(scoped?.projectKey, key).toBe("NWL");
    }
    // The org-wide pages keep every row, and honor ?project= like any source with the project column.
    expect(plan("activity/feed", "/x/activity/feed").plan?.projectKey).toBeNull();
    expect(
      plan("procurement/receipts", "/x/procurement/receipts", { project: "NWL" }).plan?.filters,
    ).toEqual([{ operator: "eq", column: "project_id", value: "NWL", resolve: "project" }]);
  });

  it("exports the reader's own open records from My Work, not the org's assignments", () => {
    const myWork = exportSourceFor("my_work", new URLSearchParams());
    expect(myWork?.relation).toBe("app.my_work_export");
    expect(myWork?.columns).toEqual(
      expect.arrayContaining(["record_number", "title", "record_state", "due_at"]),
    );
    expect(myWork?.columns).not.toContain("membership_id");
  });

  it("hides the archived projects the Projects page hides, unless it shows them (?archived=1)", () => {
    for (const key of [
      "projects",
      "projects/all",
      "projects/by_phase",
      "projects/portfolio_timeline",
    ]) {
      const projects = exportSourceFor(key, new URLSearchParams());
      if (!projects) throw new Error(`no ${key} source`);
      const filters = (query: Record<string, string>) =>
        planExport(projects, "/acme/projects", new URLSearchParams(query))?.filters;
      expect(filters({})).toEqual([{ operator: "is_null", column: "archived_at" }]);
      expect(filters({ archived: "1" })).toEqual([]);
      // A value the page does not know keeps its default, as listProjects does.
      expect(filters({ archived: "0" })).toEqual([{ operator: "is_null", column: "archived_at" }]);
      expect(filters({ archived: "constructor" })).toEqual([
        { operator: "is_null", column: "archived_at" },
      ]);
      expect(filters({ archived: "1", q: "gala" })).toEqual([
        { operator: "search", value: "gala" },
      ]);
    }
  });

  it("hides archived rows of the A124 collections unless ?archived=include or only asks", () => {
    for (const [key, path] of [
      ["work/all_records", "/acme/work/all-records"],
      ["work/work_orders", "/acme/work/work-orders"],
      ["knowledge/documents", "/acme/knowledge/documents"],
      ["places/venues", "/acme/places/venues"],
      ["vendors/directory", "/acme/vendors/directory"],
      ["objects/*", "/acme/objects/sponsors"],
    ] as const) {
      const source = exportSourceFor(key, new URLSearchParams());
      if (!source) throw new Error(`no ${key} source`);
      const filters = (query: Record<string, string>) =>
        planExport(source, path, new URLSearchParams(query))?.filters;
      expect(filters({}), key).toEqual([{ operator: "is_null", column: "archived_at" }]);
      expect(filters({ archived: "include" }), key).toEqual([]);
      expect(filters({ archived: "only" }), key).toEqual([
        { operator: "not_null", column: "archived_at" },
      ]);
      expect(filters({ archived: "1" }), key).toEqual([
        { operator: "is_null", column: "archived_at" },
      ]);
    }
  });
});
