import {
  LIST_QUERY_PARAMS,
  type AuthMode,
  type ExternalRoleType,
  type NodeKind,
  type Shell,
  type Sitemap,
  type SitemapNode,
  type ViewType,
  type Visibility,
} from "./schema";
import { compareSpecificity, fillRoute, matchRoute, routeParams } from "./routes";
import { getNode, indexSitemap } from "./tree";
import {
  effectiveVisibility,
  engagementTabIds,
  isNodeVisible,
  type NavContext,
} from "./visibility";

/** One route in a sitemap, flattened for route generation. */
export interface FlatRoute {
  readonly id: string;
  readonly route: string;
  readonly params: readonly string[];
  readonly label: string;
  readonly kind: NodeKind;
  readonly depth: number;
  readonly auth: AuthMode;
  readonly servedBy: Shell | undefined;
  readonly parentId: string | undefined;
  readonly views: readonly ViewType[] | undefined;
  readonly defaultView: ViewType | undefined;
  /** Query parameters the route accepts: list view state for list routes. */
  readonly query: readonly string[];
}

/** Every routed node in declared order. */
export function flattenRoutes(sitemap: Sitemap): FlatRoute[] {
  return indexSitemap(sitemap).order.flatMap((entry) => {
    const { node } = entry;
    if (node.route === undefined) return [];
    return [
      {
        id: node.id,
        route: node.route,
        params: routeParams(node.route),
        label: node.label,
        kind: node.kind,
        depth: entry.depth,
        auth: node.auth ?? "session",
        servedBy: node.servedBy,
        parentId: entry.parent?.node.id,
        views: node.list?.views,
        defaultView: node.list?.default,
        query: node.list ? LIST_QUERY_PARAMS : [],
      },
    ];
  });
}

export interface RouteMatch {
  readonly id: string;
  readonly route: string;
  readonly params: Readonly<Record<string, string>>;
}

/** Find the node a concrete path belongs to; static segments win over params. */
export function findRoute(sitemap: Sitemap, path: string): RouteMatch | undefined {
  const matches = flattenRoutes(sitemap).flatMap((r) => {
    const params = matchRoute(r.route, path, sitemap.params);
    return params ? [{ id: r.id, route: r.route, params }] : [];
  });
  matches.sort((a, b) => compareSpecificity(a.route, b.route));
  return matches[0];
}

export type GuardResult =
  | {
      readonly status: 200;
      readonly id: string;
      readonly params: Readonly<Record<string, string>>;
      readonly visibility: Visibility | "public" | "token";
    }
  | { readonly status: 404 };

/**
 * Route guard. A path that matches no node, or a node the context may not see, is 404,
 * never 403 (Section 4.5.3), so a hidden page cannot be told apart from a missing one.
 */
export function guardRoute(sitemap: Sitemap, path: string, ctx: NavContext): GuardResult {
  const match = findRoute(sitemap, path);
  if (!match || !isNodeVisible(sitemap, match.id, ctx)) return { status: 404 };
  const auth = getNode(sitemap, match.id).node.auth ?? "session";
  const visibility =
    auth === "session"
      ? (effectiveVisibility(sitemap, match.id, ctx.role ?? "") as Visibility)
      : auth;
  return { status: 200, id: match.id, params: match.params, visibility };
}

/** Routes this context may open, in declared order. */
export function visibleRoutes(sitemap: Sitemap, ctx: NavContext): FlatRoute[] {
  return flattenRoutes(sitemap).filter((r) => isNodeVisible(sitemap, r.id, ctx));
}

export interface CommandMenuEntry {
  readonly id: string;
  readonly label: string;
  readonly route: string;
  readonly kind: NodeKind;
  /** Label keys of the navigable ancestors, for "Finance > Budgets" style hints and search. */
  readonly context: readonly string[];
}

/**
 * Command menu index: every page this context may open whose route params are all known.
 * Atlas knows `org` everywhere and `projectKey` inside a project.
 */
export function commandMenuIndex(
  sitemap: Sitemap,
  ctx: NavContext & { readonly knownParams?: readonly string[] },
): CommandMenuEntry[] {
  const known = new Set(ctx.knownParams ?? []);
  return visibleRoutes(sitemap, ctx)
    .filter((r) => r.auth === "session" && r.params.every((p) => known.has(p)))
    .map((r) => {
      const entry = getNode(sitemap, r.id);
      return {
        id: r.id,
        label: r.label,
        route: r.route,
        kind: r.kind,
        context: entry.ancestors.filter((a) => a.navigable).map((a) => a.node.label),
      };
    });
}

export type Breadcrumb =
  | {
      readonly kind: "org" | "workspace" | "project" | "scope" | "record";
      readonly value: string;
      readonly label: string;
      readonly href?: string;
    }
  | { readonly kind: "node"; readonly id: string; readonly label: string; readonly href: string };

/**
 * Breadcrumbs follow Org, Workspace, Project, Scope node, Module, Record (Section 4.5.1).
 * Levels that do not apply are omitted. Node crumbs start after the last record-kind
 * ancestor (a project replaces the Projects list in the trail).
 */
export function resolveBreadcrumbs(
  sitemap: Sitemap,
  path: string,
  context: { readonly workspace?: string; readonly scope?: string } = {},
): Breadcrumb[] {
  const match = findRoute(sitemap, path);
  if (!match) return [];
  const entry = getNode(sitemap, match.id);
  const chain = [...entry.ancestors, entry].filter((e) => e.navigable);
  const crumbs: Breadcrumb[] = [];
  const org = match.params["org"];
  if (org !== undefined) crumbs.push({ kind: "org", value: org, label: "nav.breadcrumb.org" });
  if (context.workspace !== undefined) {
    crumbs.push({ kind: "workspace", value: context.workspace, label: "nav.breadcrumb.workspace" });
  }
  const lastRecord = chain.map((e) => e.node.kind).lastIndexOf("record");
  const trail = lastRecord >= 0 ? chain.slice(lastRecord) : chain;
  let scopeAdded = false;
  for (const link of trail) {
    const route = link.node.route as string;
    const href = fillRoute(route, match.params);
    if (link.node.kind === "record") {
      const projectKey = routeParams(route).includes("projectKey")
        ? match.params["projectKey"]
        : undefined;
      const recordParam = routeParams(route).at(-1) ?? "";
      if (projectKey !== undefined) {
        crumbs.push({ kind: "project", value: projectKey, label: link.node.label, href });
        if (context.scope !== undefined) {
          crumbs.push({ kind: "scope", value: context.scope, label: "nav.breadcrumb.scope" });
          scopeAdded = true;
        }
      } else {
        crumbs.push({
          kind: "record",
          value: match.params[recordParam] ?? "",
          label: link.node.label,
          href,
        });
      }
      continue;
    }
    crumbs.push({ kind: "node", id: link.node.id, label: link.node.label, href });
  }
  if (context.scope !== undefined && !scopeAdded) {
    const at = crumbs.findIndex((c) => c.kind === "node" || c.kind === "record");
    const scope: Breadcrumb = {
      kind: "scope",
      value: context.scope,
      label: "nav.breadcrumb.scope",
    };
    crumbs.splice(at < 0 ? crumbs.length : at, 0, scope);
  }
  return crumbs;
}

export interface NavTreeNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly route: string | undefined;
  readonly visibility: Visibility | undefined;
  readonly children: readonly NavTreeNode[];
}

function prune(sitemap: Sitemap, node: SitemapNode, ctx: NavContext): NavTreeNode[] {
  if (!isNodeVisible(sitemap, node.id, ctx)) return [];
  const children = (node.children ?? []).flatMap((c) => prune(sitemap, c, ctx));
  return [
    {
      id: node.id,
      kind: node.kind,
      label: node.label,
      route: node.route,
      visibility: ctx.role === null ? undefined : effectiveVisibility(sitemap, node.id, ctx.role),
      children,
    },
  ];
}

/**
 * The navigation tree for a context, in declared order, limited to the given placements
 * (for example `sidebar` and `footer` for the Atlas sidebar).
 */
export function navigationTree(
  sitemap: Sitemap,
  ctx: NavContext,
  placements?: readonly string[],
): NavTreeNode[] {
  return sitemap.nodes
    .filter((n) => !placements || (n.placement !== undefined && placements.includes(n.placement)))
    .flatMap((n) => prune(sitemap, n, ctx));
}

/** Sidebar groups expanded by default for an internal persona (Section 4.5.2). */
export function expandedGroups(sitemap: Sitemap, persona: string): readonly string[] {
  return sitemap.personas?.[persona] ?? [];
}

/** The ordered engagement tabs for a role type (Section 4.5.8). */
export function engagementTabs(
  sitemap: Sitemap,
  roleType: ExternalRoleType,
  representationScopes?: Iterable<string>,
): SitemapNode[] {
  return engagementTabIds(sitemap, roleType, representationScopes).map(
    (id) => getNode(sitemap, id).node,
  );
}

/** Resolve a chrome slot (for example `mobileBottomBar`) to nodes visible in this context. */
export function chromeSlot(sitemap: Sitemap, slot: string, ctx: NavContext): SitemapNode[] {
  return (sitemap.chrome?.[slot] ?? [])
    .filter((id) => isNodeVisible(sitemap, id, ctx))
    .map((id) => getNode(sitemap, id).node);
}
