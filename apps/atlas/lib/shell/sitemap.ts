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

/**
 * The URL of a node the viewer may open, for a link on a page; undefined when the node is hidden from them (or its
 * route needs a param that is missing). A link to a hidden node leads to "Page not found" (crawl 4.9).
 */
export function visibleNodeHref(
  id: string,
  params: Readonly<Record<string, string>>,
  ctx: NavContext,
): Route | undefined {
  return isNodeVisible(sitemap, id, ctx) ? nodeHref(id, params) : undefined;
}

/** The i18n key holding a page's empty state copy: `finance.change-orders` to `shell.pages.finance.changeOrders`. */
export function pageCopyKey(id: string): string {
  const path = id
    .split(".")
    .map((part) => part.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()))
    .join(".");
  return `shell.pages.${path}`;
}

/** A page's empty state: the catalog copy under `copy` (`.empty`, `.action`, with `values`) and where the action leads. */
export interface PageEmptyState {
  readonly copy: string;
  readonly values: Readonly<Record<string, string>>;
  readonly href: Route;
}

/**
 * The empty state of a generated page. A section page (one with child pages it can list; a record child needs a row) is
 * empty only when every child page is
 * hidden from the viewer, as under a role lens; it has no copy of its own, so it says no page here is open to the role
 * and leads Home (crawl 4.9: `/settings` under the Field lens showed `shell.pages.settings.empty`). A leaf page uses
 * its own copy and its empty state target.
 */
export function pageEmptyState(
  id: string,
  params: Readonly<Record<string, string>>,
  ctx: NavContext,
  section: string,
): PageEmptyState {
  const pages = navigableChildren(getNode(sitemap, id).node).filter(
    (child) => nodeHref(child.id, params) !== undefined,
  );
  if (pages.length > 0) {
    return {
      copy: "shell.page.noneOpen",
      values: { section },
      href: visibleNodeHref("home", params, ctx) ?? (`/${params["org"] ?? ""}` as Route),
    };
  }
  return { copy: pageCopyKey(id), values: {}, href: emptyStateHref(id, params, ctx) };
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
