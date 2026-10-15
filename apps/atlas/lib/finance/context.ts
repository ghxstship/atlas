import { listRoleCapabilities } from "@xos/data";
import { getProjectByKey, listProjects, type ProjectRef } from "@xos/data/finance";
import { getNode, isNodeVisible } from "@xos/ia";
import { notFound } from "next/navigation";
import { cache } from "react";
import { requireNode } from "@/components/shell/sitemap-page";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";

/**
 * Page context for the Finance and Reports pages (A15). It resolves the viewer's org context and the
 * route guard (404 for hidden nodes, ADR 0017 item 3), the capability reach the viewer holds (so a
 * Member sees write controls only where their assigned reach applies), the readable projects, and
 * the view state from the query string (Section 4.5.3 route conventions). Row level security still
 * decides every row; this only shapes what the page offers.
 */

export type Reach = "own" | "assigned" | "organization";

export interface FinanceAccess {
  /** The best reach the viewer holds for a capability, or null when they hold none. */
  readonly reach: (capability: string) => Reach | null;
  /** True when the viewer holds the capability at any reach. */
  readonly can: (capability: string) => boolean;
}

export const getAccess = cache(async (ctx: OrgContext): Promise<FinanceAccess> => {
  const result = await listRoleCapabilities(
    ctx.viewer.db,
    ctx.org.roles.map((r) => r.id),
  );
  if (!result.ok) throw new Error(`Cannot read capabilities: ${JSON.stringify(result.error)}`);
  const map = result.data;
  return { reach: (c) => map.get(c) ?? null, can: (c) => map.has(c) };
});

export const getProjects = cache(async (ctx: OrgContext): Promise<ProjectRef[]> => {
  const result = await listProjects(ctx.viewer.db, ctx.org.id);
  if (!result.ok) throw new Error(`Cannot list projects: ${JSON.stringify(result.error)}`);
  return result.data;
});

/** View state from the query string; every value is optional and validated by its page. */
export interface ViewQuery {
  readonly project: string | null;
  readonly state: string | null;
  readonly q: string | null;
  readonly view: string | null;
  readonly peek: string | null;
  readonly full: boolean;
  readonly create: boolean;
  readonly edit: boolean;
  readonly extra: Readonly<Record<string, string>>;
}

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === "" ? null : s;
};

export function parseQuery(search: SearchParams): ViewQuery {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(search)) {
    const value = first(v);
    if (value !== null) extra[k] = value;
  }
  return {
    project: first(search["project"]),
    state: first(search["state"]),
    q: first(search["q"]),
    view: first(search["view"]),
    peek: first(search["peek"]),
    full: first(search["full"]) === "1",
    create: first(search["create"]) === "1",
    edit: first(search["edit"]) === "1",
    extra,
  };
}

/** The list views a node offers (sitemap `list.views`, Section 11.15) and the default. */
export function nodeViews(node: string): { views: string[]; fallback: string } {
  const entry = getNode(sitemap, node).node;
  const views = entry.list?.views ?? ["table"];
  return { views: [...views], fallback: entry.list?.default ?? views[0] ?? "table" };
}

export interface FinancePage {
  readonly ctx: OrgContext;
  readonly access: FinanceAccess;
  readonly query: ViewQuery;
  readonly projects: readonly ProjectRef[];
  /** The project the page is filtered to: from the project tab, or `?project=KEY`. */
  readonly project: ProjectRef | null;
  /** True when the page renders as a project tab. */
  readonly inProject: boolean;
  readonly view: string;
  readonly views: readonly string[];
  /** The node the page renders for, for copy and links. */
  readonly node: string;
  /** Base path of the page without its query string. */
  readonly path: string;
}

/**
 * Resolves an org-level module page: guard, access, projects and query. An unknown `?project=` key
 * is treated as no filter rather than an error, because a stale link should still open the page.
 */
export async function loadFinancePage(
  node: string,
  params: Readonly<Record<string, string>>,
  search: SearchParams,
): Promise<FinancePage> {
  const ctx = await requireNode(node, params);
  const [access, projects] = await Promise.all([getAccess(ctx), getProjects(ctx)]);
  const query = parseQuery(search);
  const { views, fallback } = nodeViews(node);
  const route = getNode(sitemap, node).node.route ?? "";
  return {
    ctx,
    access,
    query,
    projects,
    project: projects.find((p) => p.key === query.project) ?? null,
    inProject: false,
    view: query.view && views.includes(query.view) ? query.view : fallback,
    views,
    node,
    path: route.replace("{org}", ctx.org.slug),
  };
}

/**
 * Resolves a project tab this module owns (project.budget, project.reports): the tab node must be
 * visible to the viewer, and the project must exist and be readable, or the route answers 404.
 * A07 publishes the shared project resolver; until it merges, this small lookup stands in for it.
 */
export async function loadProjectTab(
  node: string,
  moduleNode: string,
  params: Readonly<Record<string, string>>,
  search: SearchParams,
): Promise<FinancePage> {
  const slug = params["org"];
  const key = params["projectKey"];
  const ctx = slug ? await getOrgContext(slug) : null;
  if (!ctx || !key || !isNodeVisible(sitemap, node, ctx.nav)) notFound();
  const project = await getProjectByKey(ctx.viewer.db, ctx.org.id, key);
  if (!project.ok) {
    if (project.error.kind === "not-found") notFound();
    throw new Error(`Cannot read project ${key}: ${JSON.stringify(project.error)}`);
  }
  const [access, projects] = await Promise.all([getAccess(ctx), getProjects(ctx)]);
  const query = parseQuery(search);
  const { views, fallback } = nodeViews(node);
  return {
    ctx,
    access,
    query,
    projects,
    project: project.data,
    inProject: true,
    view: query.view && views.includes(query.view) ? query.view : fallback,
    views,
    node: moduleNode,
    path: `/${ctx.org.slug}/p/${project.data.key}/${node.split(".")[1] ?? ""}`,
  };
}

/** A link to the same page with some query values changed; null removes a value. */
export function withQuery(
  page: Pick<FinancePage, "path" | "query">,
  changes: Readonly<Record<string, string | null>>,
): string {
  const next = new URLSearchParams(page.query.extra);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) next.delete(k);
    else next.set(k, v);
  }
  const s = next.toString();
  return s ? `${page.path}?${s}` : page.path;
}
