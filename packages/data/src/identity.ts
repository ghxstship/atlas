import type { Database, XosClient } from "./client";

/** An insert whose org_id the database derives from its parent row (ADR 0002 tenant guards). */
type DerivedOrgInsert = Database["app"]["Tables"]["membership_roles"]["Insert"];
import { fail, ok, rowRefusal, toDataError, type Result } from "./result";

export { isOrgSlug, slugFromName } from "./slug";

/**
 * Identity repository (Section 4.8.1): people, organizations, memberships, roles and invitations.
 * Mutations go through A02's RPCs (migration 0206) or the column grants of 0205; reads go through
 * row level security, so every function sees exactly what the signed-in person may see.
 */

/** The seven platform system roles in band order (Section 8). Band 1 is Owner, band 7 Viewer. */
export const SYSTEM_ROLE_CODES = [
  "owner",
  "admin",
  "manager",
  "member",
  "collaborator",
  "field",
  "viewer",
] as const;
export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];

/** The system role whose band a role sits in; custom roles take bands 2 to 7 (ADR 0008). */
export function systemRoleForBand(band: number): SystemRoleCode | null {
  return SYSTEM_ROLE_CODES[band - 1] ?? null;
}

export interface Role {
  readonly id: string;
  readonly code: string;
  /** Display name of a custom role; null for system roles, whose labels come from the catalogs. */
  readonly name: string | null;
  readonly band: number;
  readonly system: boolean;
}

export interface Person {
  readonly id: string;
  readonly fullName: string | null;
}

export interface OrganizationSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly parentOrgId: string | null;
}

export interface MyOrganization extends OrganizationSummary {
  readonly membershipId: string;
  readonly roles: readonly Role[];
  /** Best (lowest) band among the roles held; null when the membership holds no role. */
  readonly bestBand: number | null;
}

export interface Member {
  readonly membershipId: string;
  readonly personId: string;
  readonly fullName: string | null;
  readonly validFrom: string;
  readonly roles: readonly Role[];
}

export interface PendingInvite {
  readonly id: string;
  readonly email: string;
  readonly roleId: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface InvitePreview {
  readonly orgName: string;
  readonly roleCode: string;
  readonly roleName: string | null;
  readonly expiresAt: string;
}

interface RoleRow {
  id: string;
  code: string;
  name: string | null;
  band: number;
  org_id: string | null;
}

function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    band: row.band,
    system: row.org_id === null,
  };
}

function sortRoles(roles: Role[]): Role[] {
  return roles.sort((a, b) => a.band - b.band || a.code.localeCompare(b.code));
}

/** Roles held through a membership, skipping soft-deleted assignments. */
function heldRoles(
  assignments: readonly { deleted_at: string | null; role: RoleRow | null }[] | null,
): Role[] {
  return sortRoles(
    (assignments ?? []).flatMap((a) => (a.deleted_at === null && a.role ? [toRole(a.role)] : [])),
  );
}

function bestBand(roles: readonly Role[]): number | null {
  return roles.length === 0 ? null : Math.min(...roles.map((r) => r.band));
}

/** PostgREST filter for memberships whose access window holds at `now` (Section 7.5 invariant 3). */
function activeWindow(now: Date): string {
  const at = now.toISOString();
  return `valid_to.is.null,valid_to.gt.${at}`;
}

// People ---------------------------------------------------------------------------------------

/** The person row of the signed-in user, or not-found when the sign-in has none yet. */
export async function getCurrentPerson(db: XosClient, userId: string): Promise<Result<Person>> {
  const { data, error } = await db
    .from("people")
    .select("id, full_name")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok({ id: data.id, fullName: data.full_name });
}

/** Sets the signed-in person's own name (`people.full_name`, ADR 0008 item 6). */
export async function updateMyName(
  db: XosClient,
  personId: string,
  fullName: string,
): Promise<Result<null>> {
  const { error } = await db
    .from("people")
    .update({ full_name: fullName.trim() })
    .eq("id", personId);
  return error ? fail(toDataError(error)) : ok(null);
}

// Organizations --------------------------------------------------------------------------------

/** Creates an org on the Access plan with the signed-in person as Owner (app.create_organization). */
export async function createOrganization(
  db: XosClient,
  input: { readonly name: string; readonly slug: string },
): Promise<Result<{ orgId: string }>> {
  const { data, error } = await db.rpc("create_organization", {
    p_name: input.name,
    p_slug: input.slug,
  });
  if (error) return fail(toDataError(error));
  return ok({ orgId: data });
}

/** Every org the person holds an active membership in, with the roles held, by name. */
export async function listMyOrganizations(
  db: XosClient,
  personId: string,
  now: Date = new Date(),
): Promise<Result<MyOrganization[]>> {
  const { data, error } = await db
    .from("memberships")
    .select(
      "id, organization:organizations!inner(id, slug, name, parent_org_id, deleted_at), membership_roles(deleted_at, role:roles(id, code, name, band, org_id))",
    )
    .eq("person_id", personId)
    .is("deleted_at", null)
    .is("organization.deleted_at", null)
    .lte("valid_from", now.toISOString())
    .or(activeWindow(now));
  if (error) return fail(toDataError(error));
  const orgs = data.map((row): MyOrganization => {
    const roles = heldRoles(row.membership_roles);
    return {
      id: row.organization.id,
      slug: row.organization.slug,
      name: row.organization.name,
      parentOrgId: row.organization.parent_org_id,
      membershipId: row.id,
      roles,
      bestBand: bestBand(roles),
    };
  });
  return ok(orgs.sort((a, b) => a.name.localeCompare(b.name)));
}

/**
 * The signed-in person's context in one org, by slug: the org, the membership and the roles held.
 * Not-found when the org does not exist or the person holds no active membership in it, so a
 * route guard can answer 404 without telling the two apart (ADR 0003).
 */
export async function getMyOrganization(
  db: XosClient,
  personId: string,
  slug: string,
  now: Date = new Date(),
): Promise<Result<MyOrganization>> {
  const { data, error } = await db
    .from("memberships")
    .select(
      "id, organization:organizations!inner(id, slug, name, parent_org_id, deleted_at), membership_roles(deleted_at, role:roles(id, code, name, band, org_id))",
    )
    .eq("person_id", personId)
    .eq("organization.slug", slug)
    .is("organization.deleted_at", null)
    .is("deleted_at", null)
    .lte("valid_from", now.toISOString())
    .or(activeWindow(now))
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const roles = heldRoles(data.membership_roles);
  return ok({
    id: data.organization.id,
    slug: data.organization.slug,
    name: data.organization.name,
    parentOrgId: data.organization.parent_org_id,
    membershipId: data.id,
    roles,
    bestBand: bestBand(roles),
  });
}

/** Renames the org (column grant `update (name)`, policy org.general.write). */
export async function renameOrganization(
  db: XosClient,
  orgId: string,
  name: string,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("organizations")
    .update({ name: name.trim() })
    .eq("id", orgId)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

// Capabilities ---------------------------------------------------------------------------------

/**
 * Capabilities the given roles grant with organization reach. UI permission checks use it to hide
 * controls a person cannot use; row level security still decides every act (Section 5, rule 1).
 */
export async function listRoleCapabilities(
  db: XosClient,
  roleIds: readonly string[],
): Promise<Result<Map<string, "own" | "assigned" | "organization">>> {
  if (roleIds.length === 0) return ok(new Map());
  const { data, error } = await db
    .from("role_capabilities")
    .select("capability_code, reach")
    .in("role_id", [...roleIds])
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  const order = { own: 0, assigned: 1, organization: 2 } as const;
  const reach = new Map<string, "own" | "assigned" | "organization">();
  for (const row of data) {
    const current = reach.get(row.capability_code);
    if (current === undefined || order[row.reach] > order[current]) {
      reach.set(row.capability_code, row.reach);
    }
  }
  return ok(reach);
}

// Roles and members ----------------------------------------------------------------------------

/** System roles and the org's custom roles, in band order. */
export async function listRoles(db: XosClient, orgId: string): Promise<Result<Role[]>> {
  const { data, error } = await db
    .from("roles")
    .select("id, code, name, band, org_id")
    .or(`org_id.is.null,org_id.eq.${orgId}`)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(sortRoles(data.map(toRole)));
}

/** Active members of an org with their roles, by name. Needs org.members.read or the directory. */
export async function listMembers(
  db: XosClient,
  orgId: string,
  now: Date = new Date(),
): Promise<Result<Member[]>> {
  const { data, error } = await db
    .from("memberships")
    .select(
      "id, person_id, valid_from, person:people!memberships_person_id_fkey(full_name), membership_roles(deleted_at, role:roles(id, code, name, band, org_id))",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .lte("valid_from", now.toISOString())
    .or(activeWindow(now));
  if (error) return fail(toDataError(error));
  const members = data.map((row): Member => ({
    membershipId: row.id,
    personId: row.person_id,
    fullName: row.person?.full_name ?? null,
    validFrom: row.valid_from,
    roles: heldRoles(row.membership_roles),
  }));
  return ok(
    members.sort(
      (a, b) =>
        (bestBand(a.roles) ?? 8) - (bestBand(b.roles) ?? 8) ||
        (a.fullName ?? "").localeCompare(b.fullName ?? ""),
    ),
  );
}

/**
 * Replaces a member's roles with one role. The new role is granted before the old ones end, so the
 * org never passes through a state without its Owner; the guards in 0204 refuse self-grants, bands
 * above the actor's own and removing the last open-ended Owner.
 */
export async function setMemberRole(
  db: XosClient,
  input: { readonly membershipId: string; readonly roleId: string },
): Promise<Result<null>> {
  const { data: current, error: readError } = await db
    .from("membership_roles")
    .select("id, role_id")
    .eq("membership_id", input.membershipId)
    .is("deleted_at", null);
  if (readError) return fail(toDataError(readError));
  if (!current.some((r) => r.role_id === input.roleId)) {
    // org_id is derived from the membership by the tenant guard (0200); the column grant (0205)
    // lets a signed-in person write only membership_id and role_id, so org_id is left out.
    const row = { membership_id: input.membershipId, role_id: input.roleId } as DerivedOrgInsert;
    const { error } = await db.from("membership_roles").insert(row);
    if (error) return fail(toDataError(error));
  }
  const stale = current.filter((r) => r.role_id !== input.roleId).map((r) => r.id);
  if (stale.length > 0) {
    const { error } = await db
      .from("membership_roles")
      .update({ deleted_at: new Date().toISOString() })
      .in("id", stale);
    if (error) return fail(toDataError(error));
  }
  return ok(null);
}

/** Ends another member's membership now (app.end_membership). */
export async function endMembership(db: XosClient, membershipId: string): Promise<Result<null>> {
  const { error } = await db.rpc("end_membership", { p_membership_id: membershipId });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Ends the signed-in person's own membership now (app.leave_organization). */
export async function leaveOrganization(db: XosClient, orgId: string): Promise<Result<null>> {
  const { error } = await db.rpc("leave_organization", { p_org_id: orgId });
  return error ? fail(toDataError(error)) : ok(null);
}

// Invitations ----------------------------------------------------------------------------------

/** Invites an email with a role and expiry (app.invite_member). The token is returned once. */
export async function inviteMember(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly email: string;
    readonly roleId: string;
    /** Hours until the invite expires: 1 to 720 (the RPC refuses anything else). */
    readonly validForHours?: number;
  },
): Promise<Result<{ inviteId: string; token: string }>> {
  const { data, error } = await db.rpc("invite_member", {
    p_org_id: input.orgId,
    p_email: input.email,
    p_role_id: input.roleId,
    p_valid_for: `${input.validForHours ?? 14 * 24} hours`,
  });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (!row) return fail({ kind: "unexpected", message: "invite_member returned no row" });
  return ok({ inviteId: row.invite_id, token: row.invite_token });
}

/** Pending invites of an org: not accepted, not revoked and not expired at `now`. */
export async function listPendingInvites(
  db: XosClient,
  orgId: string,
  now: Date = new Date(),
): Promise<Result<PendingInvite[]>> {
  const { data, error } = await db
    .from("invites")
    .select("id, email, role_id, expires_at, created_at")
    .eq("org_id", orgId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .is("deleted_at", null)
    .gt("expires_at", now.toISOString())
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: row.id,
      email: row.email,
      roleId: row.role_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })),
  );
}

/** Revokes a pending invite (column grant `update (revoked_at)`, policy org.members.invite). */
export async function revokeInvite(db: XosClient, inviteId: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", inviteId)
    .is("accepted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** What an invite offers, shown only to the confirmed sign-in it was sent to (app.preview_invite). */
export async function previewInvite(db: XosClient, token: string): Promise<Result<InvitePreview>> {
  const { data, error } = await db.rpc("preview_invite", { p_token: token });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (!row) return fail({ kind: "not-found" });
  if (row.refusal !== null) return fail(rowRefusal(row.reason));
  return ok({
    orgName: row.org_name,
    roleCode: row.role_code,
    roleName: row.role_name,
    expiresAt: row.expires_at,
  });
}

/** Accepts an invite for the confirmed sign-in it was sent to (app.accept_invite). */
export async function acceptInvite(
  db: XosClient,
  token: string,
): Promise<Result<{ membershipId: string }>> {
  const { data, error } = await db.rpc("accept_invite", { p_token: token });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (!row) return fail({ kind: "unexpected", message: "accept_invite returned no row" });
  if (row.refusal !== null) return fail(rowRefusal(row.reason));
  return ok({ membershipId: row.membership_id });
}

// Workspaces and plans -------------------------------------------------------------------------

export interface Workspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** Workspaces of an org, by name. */
export async function listWorkspaces(db: XosClient, orgId: string): Promise<Result<Workspace[]>> {
  const { data, error } = await db
    .from("workspaces")
    .select("id, slug, name")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok(data);
}

export interface Subscription {
  readonly planCode: string;
  readonly state: string;
}

/** The org's current subscription: the one row that is not canceled. */
export async function getSubscription(db: XosClient, orgId: string): Promise<Result<Subscription>> {
  const { data, error } = await db
    .from("subscriptions")
    .select("plan_code, subscription_state")
    .eq("org_id", orgId)
    .neq("subscription_state", "canceled")
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok({ planCode: data.plan_code, state: data.subscription_state });
}

/**
 * Whether an org is a partner (Section 4.6.1): it has at least one client org. Partner staff with
 * org.partner.manage can read their client orgs (policy organizations_read).
 */
export async function hasClientOrganizations(
  db: XosClient,
  orgId: string,
): Promise<Result<boolean>> {
  const { count, error } = await db
    .from("organizations")
    .select("id", { count: "exact", head: true })
    .eq("parent_org_id", orgId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok((count ?? 0) > 0);
}
