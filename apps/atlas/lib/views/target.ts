import { fillRoute, flattenRoutes, isNodeVisible, type NavContext, type Sitemap } from "@xos/ia";
import type { SavedViewType } from "@xos/schemas/views";
import { collectionKeyFor, viewToQuery } from "./query";
import type { Database } from "@xos/data/database.types";

export interface SavedViewQuery {
  readonly collectionKey: string;
  readonly viewType: SavedViewType;
  readonly searchText: string | null;
  readonly groupByField: string | null;
  readonly filters: readonly { field: string; value: string | null }[];
  readonly sorts: readonly {
    field: string;
    direction: Database["app"]["Enums"]["sort_direction"];
  }[];
}

export type SavedViewTarget =
  | { readonly kind: "page"; readonly href: string }
  /** A project tab view: it opens inside a project, so the person picks one first. */
  | { readonly kind: "project"; readonly tabId: string }
  /** No page the person may open shows this collection. */
  | { readonly kind: "none" };

/**
 * Where a saved view opens (Section 11.15): the org page whose collection key matches, with the
 * view's query, so `/{org}/views/{viewId}` lands on the same screen a link to the page would. The
 * page must be visible to the person (Section 4.5.9); otherwise there is nowhere to open it.
 */
export function savedViewTarget(
  sitemap: Sitemap,
  view: SavedViewQuery,
  org: string,
  nav: NavContext,
): SavedViewTarget {
  for (const route of flattenRoutes(sitemap)) {
    if (route.auth !== "session" || route.servedBy !== undefined) continue;
    const projectTab = route.params.length === 2 && route.params.includes("projectKey");
    if (!projectTab && route.params.some((p) => p !== "org")) continue;
    const path = fillRoute(route.route, { org, projectKey: "KEY" });
    if (collectionKeyFor(path) !== view.collectionKey) continue;
    if (!isNodeVisible(sitemap, route.id, nav)) return { kind: "none" };
    if (projectTab) return { kind: "project", tabId: route.id };
    const query = viewToQuery(view, route.views ?? []);
    return { kind: "page", href: query ? `${path}?${query}` : path };
  }
  return { kind: "none" };
}
