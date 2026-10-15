import { VIEW_REGISTRY } from "@xos/schemas/views";
import { describe, expect, it } from "vitest";
import { sitemap } from "@/ia/sitemap.generated";
import {
  canonicalQuery,
  collectionKeyFor,
  currentQuery,
  isBareQuery,
  queryToView,
  viewToQuery,
} from "@/lib/views/query";

describe("collection keys", () => {
  it("keys a page by its path after the org", () => {
    expect(collectionKeyFor("/demo/logistics/shipments")).toBe("logistics/shipments");
    expect(collectionKeyFor("/demo/projects")).toBe("projects");
    expect(collectionKeyFor("/demo/places/site-plans")).toBe("places/site_plans");
    expect(collectionKeyFor("/demo/p/NWL/schedule")).toBe("project/schedule");
    expect(collectionKeyFor("/demo/settings/org/teams")).toBe("settings/org_teams");
    expect(collectionKeyFor("/demo")).toBeNull();
    expect(collectionKeyFor("/demo/assets/9c1e")).toBeNull();
  });
});

describe("saved queries", () => {
  it("saves view, search, grouping, sorts and filters, never navigation state", () => {
    const search = new URLSearchParams(
      "view=board&q=inbound&group=state&sort=name,-due_at,Bad&project=NWL&peek=abc&full=1&Weird=x&empty=",
    );
    expect(queryToView(search, "board")).toEqual({
      viewType: "Board",
      searchText: "inbound",
      groupByField: "state",
      filters: [{ field: "project", operator: "eq", value: "NWL" }],
      sorts: [
        { field: "name", direction: "Ascending" },
        { field: "due_at", direction: "Descending" },
      ],
    });
    expect(queryToView(new URLSearchParams("group=Bad Field"), "made-up")).toMatchObject({
      viewType: "List",
      searchText: null,
      groupByField: null,
    });
  });

  it("opens a saved view on the matching view the page offers", () => {
    const view = {
      viewType: "Resource Schedule" as const,
      searchText: "rigging",
      groupByField: "department",
      filters: [
        { field: "project", value: "NWL" },
        { field: "nothing", value: null },
      ],
      sorts: [{ field: "starts_at", direction: "Descending" as const }],
    };
    expect(viewToQuery(view, ["table", "resource-schedule"])).toBe(
      "view=resource-schedule&project=NWL&q=rigging&group=department&sort=-starts_at",
    );
    expect(viewToQuery({ ...view, viewType: "Map" }, ["table"])).toBe(
      "project=NWL&q=rigging&group=department&sort=-starts_at",
    );
  });

  it("recognizes the saved view on screen whatever the parameter order", () => {
    const saved = viewToQuery(queryToView(new URLSearchParams("view=table&project=NWL"), "table"), [
      "table",
    ]);
    expect(
      currentQuery(new URLSearchParams("project=NWL&peek=1&view=table"), "table", ["table"]),
    ).toBe(canonicalQuery(saved));
    expect(isBareQuery(new URLSearchParams("peek=1"))).toBe(true);
    expect(isBareQuery(new URLSearchParams("project=NWL"))).toBe(false);
  });
});

describe("view registry and the sitemap", () => {
  it("knows every view a sitemap page declares", () => {
    const codes = new Set(VIEW_REGISTRY.views.map((v) => v.code));
    const unknown: string[] = [];
    let declared = 0;
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const n = node as {
        id?: string;
        list?: { views?: string[]; default?: string };
        children?: unknown[];
      };
      for (const v of [...(n.list?.views ?? []), ...(n.list?.default ? [n.list.default] : [])]) {
        declared += 1;
        if (!codes.has(v)) unknown.push(`${n.id ?? "?"}: ${v}`);
      }
      for (const value of Object.values(n)) if (Array.isArray(value)) value.forEach(walk);
    };
    walk(sitemap);
    expect(declared).toBeGreaterThan(100);
    expect(unknown).toEqual([]);
  });
});
