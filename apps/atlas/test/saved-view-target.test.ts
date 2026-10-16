import { describe, expect, it } from "vitest";
import { sitemap } from "@/ia/sitemap.generated";
import { savedViewTarget, type SavedViewQuery } from "@/lib/views/target";

const base: SavedViewQuery = {
  collectionKey: "places/venues",
  viewType: "Map",
  searchText: null,
  groupByField: null,
  filters: [],
  sorts: [],
};
const manager = { role: "manager" as const, conditions: ["desktop" as const] };

describe("saved view links (Manager saved view 404)", () => {
  it("opens the collection page with the view's query", () => {
    expect(savedViewTarget(sitemap, base, "demo-productions", manager)).toEqual({
      kind: "page",
      href: "/demo-productions/places/venues?view=map",
    });
    const filtered = savedViewTarget(
      sitemap,
      {
        ...base,
        collectionKey: "projects",
        viewType: "Table",
        filters: [{ field: "archive", value: "active" }],
        sorts: [{ field: "name", direction: "Ascending" }],
      },
      "demo-productions",
      manager,
    );
    expect(filtered).toEqual({
      kind: "page",
      href: "/demo-productions/projects?view=table&archive=active&sort=name",
    });
  });

  it("asks for a project for a project tab view", () => {
    expect(
      savedViewTarget(
        sitemap,
        { ...base, collectionKey: "project/schedule", viewType: "List" },
        "demo-productions",
        manager,
      ),
    ).toEqual({ kind: "project", tabId: "project.schedule" });
  });

  it("has nowhere to open a view of a page the person may not see, or an unknown collection", () => {
    expect(
      savedViewTarget(
        sitemap,
        { ...base, collectionKey: "settings/members" },
        "demo-productions",
        manager,
      ),
    ).toEqual({ kind: "none" });
    expect(
      savedViewTarget(sitemap, { ...base, collectionKey: "nowhere" }, "demo-productions", manager),
    ).toEqual({ kind: "none" });
  });
});
