import { listRoleCapabilities } from "@xos/data";
import {
  getAdvancingProject,
  listAdvancingProjects,
  type AdvancingProject,
} from "@xos/data/advancing";
import { isNodeVisible } from "@xos/ia";
import type { CapabilityCode } from "@xos/schemas/capabilities/codes";
import { notFound } from "next/navigation";
import { requireNode } from "@/lib/shell/require-node";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";

/**
 * Who is looking at an Advancing page and what they may do there. Controls follow the viewer's
 * capabilities at any reach (assigned reach applies on their projects); row level security and the
 * 0430 RPCs still decide every write, and a refusal is shown with its reason (Section 5, rule 1).
 */
export interface AdvancingAbilities {
  /** advancing.packet.write: create and edit packets, sections and recipients. */
  readonly write: boolean;
  /** advancing.packet.send: send packets and issue advance links. */
  readonly send: boolean;
  /** advancing.submission.review: review answers and record answers given by phone. */
  readonly review: boolean;
  /** advancing.rider.write: record riders and their fulfillment. */
  readonly rider: boolean;
  /** advancing.reconciliation.write: run reconciliations. */
  readonly reconcile: boolean;
}

export interface AdvancingContext {
  readonly ctx: OrgContext;
  readonly can: AdvancingAbilities;
  /** Projects the viewer can see, in key order, for the filter and create flows. */
  readonly projects: readonly AdvancingProject[];
  /** The project the page is scoped to: the project tab, or the `project` filter. */
  readonly project: AdvancingProject | null;
}

async function abilities(ctx: OrgContext): Promise<AdvancingAbilities> {
  const reach = await listRoleCapabilities(
    ctx.viewer.db,
    ctx.org.roles.map((r) => r.id),
  );
  if (!reach.ok) throw new Error(`Cannot read capabilities: ${JSON.stringify(reach.error)}`);
  const has = (code: CapabilityCode) => reach.data.has(code) && reach.data.get(code) !== "own";
  return {
    write: has("advancing.packet.write"),
    send: has("advancing.packet.send"),
    review: has("advancing.submission.review"),
    rider: has("advancing.rider.write"),
    reconcile: has("advancing.reconciliation.write"),
  };
}

async function projectsOf(ctx: OrgContext): Promise<AdvancingProject[]> {
  const projects = await listAdvancingProjects(ctx.viewer.db, ctx.org.id);
  if (!projects.ok) throw new Error(`Cannot list projects: ${JSON.stringify(projects.error)}`);
  return projects.data;
}

/** An org-level Advancing page (`/{org}/advancing/{page}`), optionally filtered to one project. */
export async function advancingPage(
  node: string,
  params: Readonly<Record<string, string>>,
  projectKey: string | undefined,
): Promise<AdvancingContext> {
  const ctx = await requireNode(node, params);
  const [can, projects] = await Promise.all([abilities(ctx), projectsOf(ctx)]);
  const project = projectKey ? (projects.find((p) => p.key === projectKey) ?? null) : null;
  return { ctx, can, projects, project };
}

/**
 * The project tab (`/{org}/p/{projectKey}/advancing`). The shell's guard answers 404 for routes
 * that name a project until A07's project resolver lands, so the tab resolves its project here:
 * the node must be visible to the viewer and the project must exist and be visible, else 404.
 */
export async function advancingProjectTab(
  params: Readonly<Record<string, string>>,
): Promise<AdvancingContext & { readonly project: AdvancingProject }> {
  const slug = params["org"];
  const key = params["projectKey"];
  const ctx = slug ? await getOrgContext(slug) : null;
  if (!ctx || !key || !isNodeVisible(sitemap, "project.advancing", ctx.nav)) notFound();
  const project = await getAdvancingProject(ctx.viewer.db, ctx.org.id, key);
  if (!project.ok) {
    if (project.error.kind === "not-found") notFound();
    throw new Error(`Cannot read project ${key}: ${JSON.stringify(project.error)}`);
  }
  const [can, projects] = await Promise.all([abilities(ctx), projectsOf(ctx)]);
  return { ctx, can, projects, project: project.data };
}
