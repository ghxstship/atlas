/**
 * Who is signed in, as Compass needs it: internal membership and capabilities, or external engagements,
 * and the download scope that follows (Section 4.5.7 role-aware content, Section 8.7).
 *
 * Several orgs (Section 4.5.7 org switching). A person can be a member of more than one org and engaged
 * by others. Each org is its own context: its identity (audience, capabilities, membership or
 * engagements), its download scope and its projects. One context is active at a time and drives every
 * screen; the device holds rows for all of them, each under its own scope, so the combined Today works
 * offline and nothing crosses from one org into another.
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
    // The onboarding checklist opens before operational access does (A92).
    onboardingEngagementIds: identity.engagements
      .filter((e) => e.state !== "Complete" && e.state !== "Canceled")
      .map((e) => e.id),
  };
}

export interface ProjectRef {
  readonly id: string;
  readonly name: string;
}

/** One org the person works in: as a member (internal) or through engagements (external). */
export interface OrgContext {
  readonly orgId: string;
  readonly orgName: string;
  readonly kind: "member" | "engaged";
  readonly identity: CompassIdentity;
  readonly scope: DownloadScope;
  readonly projects: readonly ProjectRef[];
}

/**
 * The resolved person with one org active. `identity`, `scope`, `orgId` and `projects` are the active
 * org's, so every screen reads one org; `contexts` lists every org, for the switcher and the combined Today.
 */
export interface ResolvedIdentity {
  readonly identity: CompassIdentity;
  readonly scope: DownloadScope;
  readonly orgId: string | null;
  readonly projects: readonly ProjectRef[];
  readonly contexts: readonly OrgContext[];
}

export class IdentityError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

/** The person with the given org active; an unknown or missing org falls back to the first context. */
export function activateOrg(
  contexts: readonly OrgContext[],
  orgId: string | null,
): ResolvedIdentity {
  const active = contexts.find((c) => c.orgId === orgId) ?? contexts[0];
  if (!active) throw new IdentityError("access", "No organization to open.");
  return {
    identity: active.identity,
    scope: active.scope,
    orgId: active.orgId,
    projects: active.projects,
    contexts,
  };
}

/**
 * The org whose replay ledger a write queued now runs in (app.apply_sync_mutation): the active org for a
 * member, none for an external context, whose RPCs are called directly (SupabaseUploader).
 */
export function replayOrgOf(resolved: ResolvedIdentity | null): string | null {
  if (!resolved) return null;
  return resolved.contexts.find((c) => c.orgId === resolved.orgId)?.kind === "member"
    ? resolved.orgId
    : null;
}

/**
 * True when an identity read failed because no server answered (offline, or the server is away), as
 * opposed to the server refusing it. Compass then opens on the identity cached at the last sign-in.
 */
export function isServerUnreachable(message: string): boolean {
  return /network request failed|fetch failed|could not connect|failed to fetch|timed out|offline|load failed/i.test(
    message,
  );
}

/** The org contexts cached on the device, or null when the row is missing or not one. */
export function cachedContexts(row: unknown): OrgContext[] | null {
  const contexts = (row as { contexts?: unknown } | null | undefined)?.contexts;
  if (!Array.isArray(contexts) || contexts.length === 0) return null;
  const valid = contexts.every((c: unknown) => {
    const context = c as Partial<OrgContext> | null;
    return (
      typeof context?.orgId === "string" &&
      (context.kind === "member" || context.kind === "engaged") &&
      typeof context.identity?.personId === "string" &&
      Array.isArray(context.projects) &&
      Array.isArray(context.scope?.orgIds)
    );
  });
  return valid ? (contexts as OrgContext[]) : null;
}

/** Which org a project belongs to, across every context. */
export function projectOrgs(contexts: readonly OrgContext[]): ReadonlyMap<string, string> {
  return new Map(contexts.flatMap((c) => c.projects.map((p) => [p.id, c.orgId] as const)));
}

interface MembershipRow {
  readonly id: string;
  readonly org_id: string;
}

/** Member contexts: capabilities per membership from its roles and its projects' project roles. */
async function memberContexts(
  client: SupabaseClient,
  personId: string,
  displayName: string,
  memberships: readonly MembershipRow[],
): Promise<OrgContext[]> {
  const orgIds = [...new Set(memberships.map((m) => m.org_id))];
  const roles = await client
    .from("membership_roles")
    .select("membership_id, role_id")
    .in(
      "membership_id",
      memberships.map((m) => m.id),
    )
    .is("deleted_at", null);
  if (roles.error) throw new IdentityError("roles", roles.error.message);
  const roleRows = roles.data as { membership_id: string; role_id: string }[];
  const roleIds = [...new Set(roleRows.map((r) => String(r.role_id)))];
  const caps = roleIds.length
    ? await client
        .from("role_capabilities")
        .select("role_id, capability_code")
        .in("role_id", roleIds)
        .is("deleted_at", null)
    : { data: [], error: null };
  if (caps.error) throw new IdentityError("capabilities", caps.error.message);
  // A project role adds capabilities on its project (SIM-007: the Field Supervisor dispatches).
  const projectRoleCaps = await client.rpc("my_project_role_capabilities");
  if (projectRoleCaps.error) throw new IdentityError("capabilities", projectRoleCaps.error.message);
  const projects = await client
    .from("projects")
    .select("id, name, org_id")
    .in("org_id", orgIds)
    .is("deleted_at", null)
    .order("name");
  if (projects.error) throw new IdentityError("projects", projects.error.message);
  // Org names for the switcher; a failed read leaves the name to the brand lookup.
  const orgs = await client.from("organizations").select("id, name").in("id", orgIds);
  const orgName = new Map(
    ((orgs.error ? [] : orgs.data) as { id: string; name: string }[]).map((o) => [
      String(o.id),
      String(o.name ?? ""),
    ]),
  );
  const capsByRole = new Map<string, string[]>();
  for (const c of caps.data as { role_id: string; capability_code: string }[]) {
    const list = capsByRole.get(String(c.role_id)) ?? [];
    list.push(String(c.capability_code));
    capsByRole.set(String(c.role_id), list);
  }
  const projectRows = projects.data as { id: string; name: string; org_id: string }[];
  const seen = new Set<string>();
  const contexts: OrgContext[] = [];
  for (const membership of memberships) {
    if (seen.has(membership.org_id)) continue;
    seen.add(membership.org_id);
    const orgProjects = projectRows
      .filter((p) => String(p.org_id) === membership.org_id)
      .map((p) => ({ id: String(p.id), name: String(p.name) }));
    const orgProjectIds = new Set(orgProjects.map((p) => p.id));
    const capabilities = [
      ...new Set([
        ...roleRows
          .filter((r) => String(r.membership_id) === membership.id)
          .flatMap((r) => capsByRole.get(String(r.role_id)) ?? []),
        ...((projectRoleCaps.data ?? []) as { project_id?: string; capability_code: string }[])
          .filter((c) => !c.project_id || orgProjectIds.has(String(c.project_id)))
          .map((c) => String(c.capability_code)),
      ]),
    ].sort();
    const identity: CompassIdentity = {
      personId,
      displayName,
      audience: internalAudience(capabilities),
      capabilities,
      membershipId: membership.id,
      engagements: [],
    };
    contexts.push({
      orgId: membership.org_id,
      orgName: orgName.get(membership.org_id) ?? "",
      kind: "member",
      identity,
      scope: scopeFor(
        identity,
        [membership.org_id],
        orgProjects.map((p) => p.id),
      ),
      projects: orgProjects,
    });
  }
  return contexts;
}

/** Engaged contexts: one per org whose engagements the person holds, unless they are a member there. */
function engagedContexts(
  personId: string,
  displayName: string,
  summaries: readonly EngagementSummary[],
  memberOrgs: ReadonlySet<string>,
): OrgContext[] {
  const byOrg = new Map<string, EngagementSummary[]>();
  for (const e of summaries) {
    if (memberOrgs.has(e.orgId)) continue;
    byOrg.set(e.orgId, [...(byOrg.get(e.orgId) ?? []), e]);
  }
  const contexts: OrgContext[] = [];
  for (const [orgId, engagements] of byOrg) {
    const audience = externalAudience(engagements, null);
    if (!audience) continue;
    const identity: CompassIdentity = {
      personId,
      displayName,
      audience,
      capabilities: [],
      membershipId: null,
      engagements,
    };
    contexts.push({
      orgId,
      orgName: engagements[0]?.orgName ?? "",
      kind: "engaged",
      identity,
      scope: scopeFor(identity, [], []),
      projects: [
        ...new Map(
          engagements.map((e) => [e.projectId, { id: e.projectId, name: e.projectName }]),
        ).values(),
      ],
    });
  }
  return contexts;
}

/**
 * Reads the signed-in person's memberships, roles and engagements in every org, and activates the
 * preferred org (the one the device remembers) or the first. Throws IdentityError naming the step.
 */
export async function resolveIdentity(
  client: SupabaseClient,
  userId: string,
  preferredOrgId: string | null = null,
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
  const membershipRows = (memberships.data as MembershipRow[]).map((m) => ({
    id: String(m.id),
    org_id: String(m.org_id),
  }));
  const members =
    membershipRows.length > 0
      ? await memberContexts(client, personId, displayName, membershipRows)
      : [];

  const engagements = await client
    .schema("api_external")
    .from("engagements")
    .select("id, org_id, org_name, project_id, project_name, role_type, engagement_state");
  // A member whose engagement read fails still opens their own orgs; only an external sign-in needs it.
  if (engagements.error && members.length === 0)
    throw new IdentityError("engagements", engagements.error.message);
  const summaries: EngagementSummary[] = [];
  for (const e of engagements.error ? [] : engagements.data) {
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
  const contexts = [
    ...members,
    ...engagedContexts(personId, displayName, summaries, new Set(members.map((c) => c.orgId))),
  ];
  if (contexts.length === 0)
    throw new IdentityError(
      "engagements",
      "This sign-in has no organization membership and no engagement.",
    );
  return activateOrg(contexts, preferredOrgId);
}
