/**
 * Who is signed in, as Compass needs it: internal membership and capabilities, or external engagements,
 * and the download scope that follows (Section 4.5.7 role-aware content, Section 8.7).
 *
 * Capabilities here only shape which controls show; row level security and the RPCs decide every act.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Audience, DownloadScope } from "@xos/sync";
import type { CompassIdentity, EngagementState, EngagementSummary } from "../domain/access";

/**
 * Field Supervisor and above hold one of these (Section 4.5.7 supervisor mode). The Field role holds none
 * since migration 1110 (SIM-007); a Field Supervisor gets dispatch from the project role.
 */
const SUPERVISOR_CAPABILITIES = [
  "crew.timesheet.approve",
  "safety.incident.dispatch",
  "crew.shift.write",
];

/** External role types as app.external_role_type spells them, mapped to Compass audiences. */
const ROLE_TYPE_AUDIENCE: Readonly<Record<string, Audience>> = {
  Crew: "crew",
  Staff: "staff",
  Vendor: "vendor",
  Contractor: "contractor",
  Artist: "artist",
  "Artist Representative": "artist-representative",
  Client: "client",
  Sponsor: "sponsor",
};

export function audienceForRoleType(roleType: string): Audience | null {
  return ROLE_TYPE_AUDIENCE[roleType] ?? null;
}

export function internalAudience(capabilities: readonly string[]): Audience {
  return SUPERVISOR_CAPABILITIES.some((c) => capabilities.includes(c))
    ? "field-supervisor"
    : "field";
}

/**
 * The audience for a person holding external engagements: the role type of their engagements in the
 * current project, else of their first operational engagement, so Today shows their own content.
 */
export function externalAudience(
  engagements: readonly EngagementSummary[],
  projectId: string | null,
): Audience | null {
  const open = engagements.filter((e) => e.state === "Active" || e.state === "Closing");
  const pick = open.find((e) => e.projectId === projectId) ?? open[0] ?? engagements[0];
  return pick?.roleType ?? null;
}

export function scopeFor(
  identity: CompassIdentity,
  orgIds: readonly string[],
  readableProjectIds: readonly string[],
): DownloadScope {
  const open = identity.engagements.filter((e) => e.state === "Active" || e.state === "Closing");
  return {
    audience: identity.audience,
    personIds: [identity.personId],
    orgIds,
    membershipIds: identity.membershipId ? [identity.membershipId] : [],
    readableProjectIds,
    engagementIds: open.map((e) => e.id),
    engagedProjectIds: [...new Set(open.map((e) => e.projectId))],
  };
}

export interface ResolvedIdentity {
  readonly identity: CompassIdentity;
  readonly scope: DownloadScope;
  readonly orgId: string | null;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
}

export class IdentityError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

/** Reads the signed-in person's memberships, roles and engagements. Throws IdentityError naming the step. */
export async function resolveIdentity(
  client: SupabaseClient,
  userId: string,
): Promise<ResolvedIdentity> {
  const person = await client
    .from("people")
    .select("id, full_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (person.error) throw new IdentityError("person", person.error.message);
  if (!person.data) throw new IdentityError("person", "No person is linked to this sign-in.");
  const personId = String(person.data.id);
  const displayName = String(person.data.full_name ?? "");

  const memberships = await client
    .from("memberships")
    .select("id, org_id")
    .eq("person_id", personId)
    .is("deleted_at", null);
  if (memberships.error) throw new IdentityError("memberships", memberships.error.message);
  const membership = memberships.data[0] as { id: string; org_id: string } | undefined;

  if (membership) {
    const roles = await client
      .from("membership_roles")
      .select("role_id")
      .eq("membership_id", membership.id)
      .is("deleted_at", null);
    if (roles.error) throw new IdentityError("roles", roles.error.message);
    const roleIds = roles.data.map((r) => String(r.role_id));
    const caps = roleIds.length
      ? await client
          .from("role_capabilities")
          .select("capability_code")
          .in("role_id", roleIds)
          .is("deleted_at", null)
      : { data: [], error: null };
    if (caps.error) throw new IdentityError("capabilities", caps.error.message);
    // A project role adds capabilities on its project (SIM-007: the Field Supervisor dispatches).
    const projectRoleCaps = await client.rpc("my_project_role_capabilities");
    if (projectRoleCaps.error)
      throw new IdentityError("capabilities", projectRoleCaps.error.message);
    const capabilities = [
      ...new Set([
        ...caps.data.map((c) => String(c.capability_code)),
        ...((projectRoleCaps.data ?? []) as { capability_code: string }[]).map((c) =>
          String(c.capability_code),
        ),
      ]),
    ].sort();
    const projects = await client
      .from("projects")
      .select("id, name")
      .eq("org_id", membership.org_id)
      .is("deleted_at", null)
      .order("name");
    if (projects.error) throw new IdentityError("projects", projects.error.message);
    const identity: CompassIdentity = {
      personId,
      displayName,
      audience: internalAudience(capabilities),
      capabilities,
      membershipId: membership.id,
      engagements: [],
    };
    const projectList = projects.data.map((p) => ({ id: String(p.id), name: String(p.name) }));
    return {
      identity,
      scope: scopeFor(
        identity,
        [membership.org_id],
        projectList.map((p) => p.id),
      ),
      orgId: membership.org_id,
      projects: projectList,
    };
  }

  const engagements = await client
    .schema("api_external")
    .from("engagements")
    .select("id, org_id, org_name, project_id, project_name, role_type, engagement_state");
  if (engagements.error) throw new IdentityError("engagements", engagements.error.message);
  const summaries: EngagementSummary[] = [];
  for (const e of engagements.data) {
    const audience = audienceForRoleType(String(e.role_type));
    if (!audience) continue;
    summaries.push({
      id: String(e.id),
      orgId: String(e.org_id),
      orgName: String(e.org_name),
      projectId: String(e.project_id),
      projectName: String(e.project_name),
      roleType: audience,
      state: e.engagement_state as EngagementState,
    });
  }
  const audience = externalAudience(summaries, null);
  if (!audience)
    throw new IdentityError(
      "engagements",
      "This sign-in has no organization membership and no engagement.",
    );
  const identity: CompassIdentity = {
    personId,
    displayName,
    audience,
    capabilities: [],
    membershipId: null,
    engagements: summaries,
  };
  const projects = [
    ...new Map(
      summaries.map((e) => [e.projectId, { id: e.projectId, name: e.projectName }]),
    ).values(),
  ];
  return {
    identity,
    scope: scopeFor(identity, [], []),
    orgId: summaries[0]?.orgId ?? null,
    projects,
  };
}
