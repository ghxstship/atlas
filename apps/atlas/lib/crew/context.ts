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
import { isNodeVisible } from "@xos/ia";
import { notFound } from "next/navigation";
import { cache } from "react";
import { requireNode } from "@/components/shell/sitemap-page";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";

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

/**
 * requireNode answers 404 for every route that names a project until A07's project resolver lands,
 * so project tabs apply the same guard here: org context, node visibility, then the project lookup.
 */
async function guard(node: string, params: Readonly<Record<string, string>>): Promise<OrgContext> {
  if (params["projectKey"] === undefined) return requireNode(node, params);
  const ctx = params["org"] === undefined ? null : await getOrgContext(params["org"]);
  if (!ctx || !isNodeVisible(sitemap, node, ctx.nav)) notFound();
  return ctx;
}

export async function getCrewContext(
  node: string,
  params: Readonly<Record<string, string>>,
): Promise<CrewContext> {
  const ctx = await guard(node, params);
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

/** The page's search params as plain strings (first value wins). */
export type SearchParams = Readonly<Record<string, string | undefined>>;

export function flatParams(raw: Record<string, string | string[] | undefined>): SearchParams {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}

/** The query string of the current view with some keys replaced or removed. */
export function withParams(
  base: string,
  current: SearchParams,
  changes: Readonly<Record<string, string | null>>,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) if (v !== undefined) q.set(k, v);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}
