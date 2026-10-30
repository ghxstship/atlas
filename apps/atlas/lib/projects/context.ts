import { listRoleCapabilities } from "@xos/data";
import { getProjectByKey, type ProjectSummary } from "@xos/data/projects";
import type { CapabilityCode } from "@xos/schemas/capabilities/codes";
import { cache } from "react";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";

/**
 * The viewer's context in one project, resolved once per request (React cache) for the project
 * layout, every project tab and their actions. Null means the project does not exist or the viewer
 * may not read it (invariant 2), and callers answer 404 (ADR 0003). Row level security and the
 * RPCs still decide every read and write; `capabilities` only hides controls the viewer cannot use.
 */
export interface ProjectContext {
  readonly org: OrgContext;
  readonly project: ProjectSummary;
  /** True when the viewer holds an active project membership. */
  readonly member: boolean;
  /**
   * Capabilities usable on this project: those held at organization reach, plus those held at
   * assigned reach when the viewer is a project member (ADR 0016 item 1).
   */
  readonly capabilities: ReadonlySet<CapabilityCode>;
}

const resolve = cache(async (slug: string, projectKey: string): Promise<ProjectContext | null> => {
  const org = await getOrgContext(slug);
  if (!org) return null;
  const db = org.viewer.db;
  const project = await getProjectByKey(db, org.org.id, projectKey);
  if (!project.ok) {
    if (project.error.kind === "not-found") return null;
    throw new Error(`Cannot read project ${projectKey}: ${JSON.stringify(project.error)}`);
  }
  const now = new Date().toISOString();
  const [membership, reach] = await Promise.all([
    db
      .from("project_members")
      .select("id")
      .eq("project_id", project.data.id)
      .eq("membership_id", org.org.membershipId)
      .is("deleted_at", null)
      .lte("valid_from", now)
      .or(`valid_to.is.null,valid_to.gt.${now}`)
      .limit(1),
    listRoleCapabilities(
      db,
      org.org.roles.map((r) => r.id),
    ),
  ]);
  if (membership.error) {
    throw new Error(`Cannot read project membership: ${membership.error.message}`);
  }
  if (!reach.ok) throw new Error(`Cannot read capabilities: ${JSON.stringify(reach.error)}`);
  const member = membership.data.length > 0;
  const capabilities = new Set(
    [...reach.data]
      .filter(([, r]) => r === "organization" || (member && r === "assigned"))
      .map(([c]) => c),
  );
  return { org, project: project.data, member, capabilities };
});

/** The project context for an org context and a project key, or null (answer 404). */
export async function getProjectContext(
  orgCtx: OrgContext,
  projectKey: string,
): Promise<ProjectContext | null> {
  return resolve(orgCtx.org.slug, projectKey);
}

/** The project context from route params, or null when either the org or the project is hidden. */
export async function getProjectContextFor(
  params: Readonly<Record<string, string>>,
): Promise<ProjectContext | null> {
  const slug = params["org"];
  const key = params["projectKey"];
  if (slug === undefined || key === undefined) return null;
  return resolve(slug, key);
}
