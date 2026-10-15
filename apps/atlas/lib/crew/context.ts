import { listRoleCapabilities } from "@xos/data";
import {
  getCrewProject,
  listCanonRoles,
  listCrewMembers,
  listCrewProjects,
  type CanonRole,
  type MemberRef,
  type ProjectRef,
} from "@xos/data/crew";
import { notFound } from "next/navigation";
import { cache } from "react";
import { requireNode } from "@/components/shell/sitemap-page";
import type { OrgContext } from "@/lib/shell/context";

/**
 * The context every People and Crew page shares: the org context (404 when hidden, Section 4.5.9),
 * the reach of each capability the viewer holds, and the lookups the pages render names from. Row
 * level security decides every row; reach only decides which controls render (Section 5, rule 1).
 */

export type Reach = "own" | "assigned" | "organization";

export interface CrewContext {
  readonly ctx: OrgContext;
  readonly orgId: string;
  readonly slug: string;
  readonly membershipId: string;
  /** True when the viewer holds the capability at any reach. */
  readonly can: (capability: string) => boolean;
  /** True when the viewer holds the capability across the org. */
  readonly canAll: (capability: string) => boolean;
  /** The project a project tab is scoped to; null on org-level pages. */
  readonly project: ProjectRef | null;
}

const reachOf = cache(async (orgSlug: string, ctx: OrgContext) => {
  const result = await listRoleCapabilities(
    ctx.viewer.db,
    ctx.org.roles.map((r) => r.id),
  );
  if (!result.ok) throw new Error(`Cannot read capabilities for ${orgSlug}: ${result.error.kind}`);
  return result.data;
});

export async function getCrewContext(
  node: string,
  params: Readonly<Record<string, string>>,
): Promise<CrewContext> {
  const ctx = await requireNode(node, params);
  const reach = await reachOf(ctx.org.slug, ctx);
  let project: ProjectRef | null = null;
  const projectKey = params["projectKey"];
  if (projectKey !== undefined) {
    const found = await getCrewProject(ctx.viewer.db, ctx.org.id, projectKey);
    if (!found.ok) {
      if (found.error.kind === "not-found") notFound();
      throw new Error(`Cannot read project ${projectKey}: ${found.error.kind}`);
    }
    project = found.data;
  }
  return {
    ctx,
    orgId: ctx.org.id,
    slug: ctx.org.slug,
    membershipId: ctx.org.membershipId,
    can: (capability) => reach.has(capability),
    canAll: (capability) => reach.get(capability) === "organization",
    project,
  };
}

/** Canon roles by code, read once per request. */
export const getRoleTitles = cache(async (ctx: OrgContext): Promise<Map<string, CanonRole>> => {
  const roles = await listCanonRoles(ctx.viewer.db);
  if (!roles.ok) throw new Error(`Cannot read the Roles Library: ${roles.error.kind}`);
  return new Map(roles.data.map((r) => [r.code, r]));
});

export const getProjects = cache(async (ctx: OrgContext): Promise<ProjectRef[]> => {
  const projects = await listCrewProjects(ctx.viewer.db, ctx.org.id);
  if (!projects.ok) throw new Error(`Cannot list projects: ${projects.error.kind}`);
  return projects.data;
});

export const getMembers = cache(async (ctx: OrgContext): Promise<MemberRef[]> => {
  const members = await listCrewMembers(ctx.viewer.db, ctx.org.id);
  if (!members.ok) throw new Error(`Cannot list members: ${members.error.kind}`);
  return members.data;
});

export { flatParams, withParams, type SearchParams } from "./query";
