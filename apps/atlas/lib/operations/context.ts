import { getNode, isNodeVisible } from "@xos/ia";
import {
  MODULE_CAPABILITIES,
  myModuleCapabilities,
  myModuleCapabilityProjects,
  operationsProjectByKey,
  operationsProjects,
  type ModuleCapability,
  type OperationsProject,
} from "@xos/data/credentials";
import { notFound } from "next/navigation";
import { requireNode } from "@/lib/shell/require-node";
import { param, type SearchParams } from "@/components/operations/kit";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import { nodeHref, sitemap } from "@/lib/shell/sitemap";
import { getTranslate, type Translate } from "@/lib/shell/translate";

/**
 * Everything a Credentials or Safety incident page needs before it renders: the org context (404
 * when the node is hidden from the viewer, ADR 0017), the projects for the filter, the project in
 * scope, the capabilities that decide which controls to offer, and the view. Row level security
 * still decides every read and write; capabilities only hide controls a person cannot use.
 */
export interface ModulePage {
  readonly ctx: OrgContext;
  readonly t: Translate;
  readonly node: string;
  readonly search: SearchParams;
  /** The page's path without a query string. */
  readonly base: string;
  readonly projects: readonly OperationsProject[];
  /** The project in scope: fixed on a project tab, or chosen with `?project=KEY`. */
  readonly project: OperationsProject | null;
  /** True on a project tab, where the project cannot be changed. */
  readonly projectFixed: boolean;
  readonly caps: ReadonlySet<ModuleCapability>;
  /**
   * With no project in scope, the projects (by id) on which each capability may be used: `caps` holds only what the
   * org grants org-wide, so a capability held on one's own projects (assigned reach, a project role, a grant) shows
   * here alone (crawl 4.9). Empty when a project is in scope, where `caps` already answers for it.
   */
  readonly capabilityProjects: ReadonlyMap<ModuleCapability, ReadonlySet<string>>;
  readonly views: readonly string[];
  readonly view: string;
}

export function can(page: ModulePage, capability: ModuleCapability): boolean {
  return page.caps.has(capability);
}

/**
 * The projects to choose for a capability: the project in scope when it grants it, otherwise every project of the
 * filter that grants it (capabilityProjects). An org-level page offers the control, with a choose-a-project prompt
 * listing these, whenever this is not empty.
 */
export function projectsWith(
  page: ModulePage,
  capability: ModuleCapability,
): readonly OperationsProject[] {
  if (page.project) return can(page, capability) ? [page.project] : [];
  const ids = page.capabilityProjects.get(capability);
  return ids ? page.projects.filter((p) => ids.has(p.id)) : [];
}

/** True when the capability may be used on this project: the one in scope, or one of capabilityProjects. */
export function canOnProject(
  page: ModulePage,
  capability: ModuleCapability,
  projectId: string,
): boolean {
  if (page.project) return page.project.id === projectId && can(page, capability);
  return (
    can(page, capability) || (page.capabilityProjects.get(capability)?.has(projectId) ?? false)
  );
}

async function capabilityProjectsFor(
  ctx: OrgContext,
  project: OperationsProject | null,
): Promise<ReadonlyMap<ModuleCapability, ReadonlySet<string>>> {
  if (project) return new Map();
  const held = await myModuleCapabilityProjects(ctx.viewer.db, ctx.org.id);
  if (!held.ok)
    throw new Error(`Cannot read the projects' capabilities: ${JSON.stringify(held.error)}`);
  return held.data;
}

async function capabilitiesFor(
  ctx: OrgContext,
  project: OperationsProject | null,
): Promise<ReadonlySet<ModuleCapability>> {
  if (project) {
    const held = await myModuleCapabilities(ctx.viewer.db, project.id);
    if (!held.ok)
      throw new Error(`Cannot read project capabilities: ${JSON.stringify(held.error)}`);
    return held.data;
  }
  return new Set(MODULE_CAPABILITIES.filter((c) => ctx.capabilities.has(c)));
}

/** The view to render: the requested one when the node offers it, otherwise the node's default. */
export function chooseView(
  node: string,
  requested: string | undefined,
): { views: string[]; view: string } {
  const list = getNode(sitemap, node).node.list;
  const views = list ? [...list.views] : [];
  const view = requested && views.includes(requested as never) ? requested : (list?.default ?? "");
  return { views, view };
}

/** An org-level module page (credentials.* and safety.* nodes). */
export async function loadModulePage(
  node: string,
  params: Readonly<Record<string, string>>,
  search: SearchParams,
): Promise<ModulePage> {
  const ctx = await requireNode(node, params);
  const [projects, t] = await Promise.all([
    operationsProjects(ctx.viewer.db, ctx.org.id),
    getTranslate(),
  ]);
  if (!projects.ok) throw new Error(`Cannot list projects: ${JSON.stringify(projects.error)}`);
  const key = param(search, "project");
  const project = key ? (projects.data.find((p) => p.key === key) ?? null) : null;
  const [caps, capabilityProjects] = await Promise.all([
    capabilitiesFor(ctx, project),
    capabilityProjectsFor(ctx, project),
  ]);
  return {
    ctx,
    t,
    node,
    search,
    base: nodeHref(node, params) ?? `/${ctx.org.slug}`,
    projects: projects.data,
    project,
    projectFixed: false,
    caps,
    capabilityProjects,
    ...chooseView(node, param(search, "view")),
  };
}

/**
 * A project tab page (project.credentials). The shell's requireNode answers 404 for routes that
 * name a project until A07's project resolver lands (broadcast 1, item 4), so this guard checks the
 * node's visibility and resolves the project itself; a hidden node or unknown key is 404.
 */
export async function loadProjectTab(
  node: string,
  params: Readonly<Record<string, string>>,
  search: SearchParams,
): Promise<ModulePage> {
  const slug = params["org"];
  const projectKey = params["projectKey"];
  const ctx = slug ? await getOrgContext(slug) : null;
  if (!ctx || !projectKey || !isNodeVisible(sitemap, node, ctx.nav)) notFound();
  const [project, t] = await Promise.all([
    operationsProjectByKey(ctx.viewer.db, ctx.org.id, projectKey),
    getTranslate(),
  ]);
  if (!project.ok) {
    if (project.error.kind === "not-found") notFound();
    throw new Error(`Cannot read the project: ${JSON.stringify(project.error)}`);
  }
  const caps = await capabilitiesFor(ctx, project.data);
  return {
    ctx,
    t,
    node,
    search,
    base: nodeHref(node, params) ?? `/${ctx.org.slug}`,
    projects: [project.data],
    project: project.data,
    projectFixed: true,
    caps,
    capabilityProjects: new Map(),
    ...chooseView(node, param(search, "view")),
  };
}
