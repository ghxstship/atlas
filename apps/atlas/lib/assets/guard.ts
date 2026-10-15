import { isNodeVisible } from "@xos/ia";
import { resolveAssetsProject, type ProjectRef } from "@xos/data/assets";
import { notFound } from "next/navigation";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";

/**
 * Route guard for the project Assets tab (`/{org}/p/{projectKey}/assets`). The shell's requireNode
 * answers 404 for routes that name a data row until A07's project resolver lands, so this small
 * local lookup applies the same rule: the node must be visible to the viewer and the project must
 * resolve under row level security, else 404 (ADR 0003).
 */
export async function requireProjectTab(
  node: string,
  params: Readonly<Record<string, string>>,
): Promise<{ ctx: OrgContext; project: ProjectRef }> {
  const slug = params["org"];
  const key = params["projectKey"];
  const ctx = slug === undefined ? null : await getOrgContext(slug);
  if (!ctx || key === undefined || !isNodeVisible(sitemap, node, ctx.nav)) notFound();
  const project = await resolveAssetsProject(ctx.viewer.db, ctx.org.id, key);
  if (!project.ok) {
    if (project.error.kind === "not-found") notFound();
    throw new Error(`Cannot read project ${key}: ${JSON.stringify(project.error)}`);
  }
  return { ctx, project: project.data };
}
