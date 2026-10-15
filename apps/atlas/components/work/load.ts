import { listRoleCapabilities } from "@xos/data";
import {
  getProjectRef,
  listPeopleRefs,
  listPhaseOptions,
  listProjectRefs,
  listRecordKinds,
  listRecordStates,
  listRecordTransitions,
  listXyzTags,
  type CanonOption,
  type PersonRef,
  type ProjectRef,
  type RecordKindInfo,
  type RecordStateInfo,
  type TransitionRule,
} from "@xos/data/work";
import { getNode, isNodeVisible } from "@xos/ia";
import { notFound } from "next/navigation";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";

/**
 * Server loaders shared by the Schedule, Work and Show pages (A08). Each page resolves the viewer's
 * org context, checks the sitemap node is visible (404 otherwise, ADR 0003), then reads what it
 * needs through @xos/data; row level security decides every row.
 */

/** Unwraps a repository result or throws, so the page's error boundary shows the error state. */
export function must<T>(
  result: { ok: true; data: T } | { ok: false; error: unknown },
  what: string,
): T {
  if (!result.ok) throw new Error(`Cannot load ${what}: ${JSON.stringify(result.error)}`);
  return result.data;
}

/** The org context for a node, or 404 when the org, membership or node is not visible. */
export async function requireModuleNode(
  node: string,
  params: Readonly<Record<string, string>>,
): Promise<OrgContext> {
  const slug = params["org"];
  const ctx = slug === undefined ? null : await getOrgContext(slug);
  if (!ctx || !isNodeVisible(sitemap, node, ctx.nav)) notFound();
  return ctx;
}

/** The project a project tab route names, or 404 when it does not exist or is not readable. */
export async function requireProject(ctx: OrgContext, projectKey: string): Promise<ProjectRef> {
  const project = await getProjectRef(ctx.viewer.db, ctx.org.id, projectKey);
  if (!project.ok) {
    if (project.error.kind === "not-found") notFound();
    throw new Error(`Cannot load project ${projectKey}: ${JSON.stringify(project.error)}`);
  }
  return project.data;
}

/** The views a sitemap node declares, in its order, with its default first. */
export function nodeViews(node: string): { views: string[]; defaultView: string } {
  const list = getNode(sitemap, node).node.list;
  const views = list ? [...list.views] : ["list"];
  return { views, defaultView: list?.default ?? views[0] ?? "list" };
}

/**
 * Capabilities the viewer holds at any reach. Controls are shown for any reach; row level security
 * and the RPCs still refuse an act on a project the person is not assigned to.
 */
export async function capabilitySet(ctx: OrgContext): Promise<ReadonlySet<string>> {
  const reach = must(
    await listRoleCapabilities(
      ctx.viewer.db,
      ctx.org.roles.map((r) => r.id),
    ),
    "capabilities",
  );
  return new Set(reach.keys());
}

export interface RecordMeta {
  readonly kinds: readonly RecordKindInfo[];
  readonly states: readonly RecordStateInfo[];
  readonly rules: readonly TransitionRule[];
  readonly projects: readonly ProjectRef[];
  readonly people: readonly PersonRef[];
  readonly phases: readonly (CanonOption & { gate: number })[];
  readonly xyzTags: readonly string[];
}

/** Canon and org lists every record collection, form and peek needs. */
export async function loadRecordMeta(ctx: OrgContext): Promise<RecordMeta> {
  const db = ctx.viewer.db;
  const [kinds, states, rules, projects, people, phases, xyz] = await Promise.all([
    listRecordKinds(db),
    listRecordStates(db),
    listRecordTransitions(db),
    listProjectRefs(db, ctx.org.id),
    listPeopleRefs(db, ctx.org.id),
    listPhaseOptions(db),
    listXyzTags(db),
  ]);
  const tags = new Set(must(xyz, "XYZ tags"));
  // Z (Timeline) is a schema family no canon category carries; records may still declare it.
  tags.add("Z");
  return {
    kinds: must(kinds, "record kinds"),
    states: must(states, "record states"),
    rules: must(rules, "record transitions"),
    projects: must(projects, "projects"),
    people: must(people, "people"),
    phases: must(phases, "phases"),
    xyzTags: [...tags].sort(),
  };
}

export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** One query parameter as a string. */
export function param(search: SearchParams, name: string): string | undefined {
  const value = search[name];
  return Array.isArray(value) ? value[0] : value;
}

/** A comma-separated query parameter as a list. */
export function listParam(search: SearchParams, name: string): string[] {
  return (param(search, name) ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}
