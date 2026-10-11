import {
  fillRoute,
  getNode,
  isNodeVisible,
  routeParams,
  type NavContext,
  type SitemapNode,
} from "@xos/ia";
import type { Route } from "next";
import { sitemap } from "@/ia/sitemap.generated";
import { DATA_PARAMS, EMPTY_STATE_TARGETS } from "@/ia/routes.config";

export { sitemap };

/** The URL of a node with the params at hand; undefined when the route needs one that is missing. */
export function nodeHref(id: string, params: Readonly<Record<string, string>>): Route | undefined {
  const node = getNode(sitemap, id).node;
  if (node.route === undefined) return undefined;
  if (!routeParams(node.route).every((p) => params[p] !== undefined)) return undefined;
  return fillRoute(node.route, params) as Route;
}

/** The i18n key holding a page's empty state copy: `finance.change-orders` to `shell.pages.finance.changeOrders`. */
export function pageCopyKey(id: string): string {
  const path = id
    .split(".")
    .map((part) => part.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()))
    .join(".");
  return `shell.pages.${path}`;
}

/** Navigable children of a node (looking through groups), in sitemap order. */
export function navigableChildren(node: SitemapNode): SitemapNode[] {
  return (node.children ?? []).flatMap((child) =>
    child.kind === "group" || child.kind === "action" ? navigableChildren(child) : [child],
  );
}

/** Whether a route names a data row (project, record, saved view, custom object). */
export function namesDataRow(route: string): boolean {
  return routeParams(route).some((p) => (DATA_PARAMS as readonly string[]).includes(p));
}

/**
 * Where a page's empty state action leads: the target page when it names one the viewer may open,
 * otherwise the page's own create flow.
 */
export function emptyStateHref(
  id: string,
  params: Readonly<Record<string, string>>,
  ctx: NavContext,
): Route {
  const target = EMPTY_STATE_TARGETS[id];
  if (target !== undefined && isNodeVisible(sitemap, target, ctx)) {
    const href = nodeHref(target, params);
    if (href !== undefined) return href;
  }
  return `${nodeHref(id, params) ?? "/"}?create=1` as Route;
}
