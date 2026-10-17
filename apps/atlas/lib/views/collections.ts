import { fillRoute, flattenRoutes, type Sitemap } from "@xos/ia";
import { collectionKeyFor } from "./query";

/**
 * The catalog label of the page a saved view's collection belongs to (for example
 * `nav.atlas.pages.projects.all`), found the same way `savedViewTarget` finds the page; null when no
 * page shows the collection.
 */
export function collectionLabelKey(sitemap: Sitemap, collectionKey: string): string | null {
  for (const route of flattenRoutes(sitemap)) {
    if (route.auth !== "session" || route.servedBy !== undefined) continue;
    const projectTab = route.params.length === 2 && route.params.includes("projectKey");
    if (!projectTab && route.params.some((p) => p !== "org")) continue;
    const path = fillRoute(route.route, { org: "org", projectKey: "KEY" });
    if (collectionKeyFor(path) === collectionKey) return route.label;
  }
  return null;
}
