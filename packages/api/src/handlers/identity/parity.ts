/**
 * Identity handlers added for API parity (A04P, ADR 0023), beside A30's handlers in identity.ts:
 * the caller (`me`), people, organizations, memberships and their roles, project assignments,
 * external account memberships and roles, representations, invites, verified domains, profile
 * section visibility and organization verifications. Tables are read and written as the caller;
 * organization creation, client organizations, leaving, ending a membership, invites and
 * representations go through their RPCs, so the database decides every refusal.
 */
import {
  endMembership,
  inviteMember,
  leaveOrganization,
  previewInvite,
  acceptInvite,
  revokeInvite,
  createOrganization,
} from "@xos/data/identity";
import { removeAccountRole } from "@xos/data/account-roles";
import {
  acceptRepresentation,
  addAccountMember,
  endAccountMembership,
  proposeRepresentation,
  revokeRepresentation,
} from "@xos/data/gateway";
import type { Components } from "../../contract/operations.generated.ts";
import { notFound } from "../../problem.ts";
import type { RequestContext } from "../../runtime/context.ts";
import { requireOrg, requirePerson } from "../../runtime/context.ts";
import type { HandlerSet } from "../../runtime/handler.ts";
import { created, noContent, ok } from "../../runtime/handler.ts";
import { from, handlersFor, rpc, run, tableResource, unwrap } from "../support/table.ts";
import type { Row } from "../support/table.ts";

type Membership = Components["Membership"];

// Representations: scopes are rows of app.representation_scopes ---------------------------------------

async function scopesOf(context: RequestContext, representationId: unknown): Promise<string[]> {
  const rows = await run<{ scope: string }[]>(
    from(context.db, "representation_scopes")
      .select("scope")
      .eq("representation_id", representationId)
      .is("deleted_at", null)
      .order("scope", { ascending: true }),
  );
  return rows.map((r) => r.scope);
}

const representations = tableResource("representations", {
  verbs: ["list", "get"],
  derived: ["scopes"],
  toContract: async (row, context) => ({ ...row, scopes: await scopesOf(context, row["id"]) }),
});

// Memberships ---------------------------------------------------------------------------------------

// Memberships change only through their RPCs: callers hold no insert or update grant (0202).
const memberships = tableResource("memberships", { verbs: ["list", "get"] });

const invites = tableResource("invites", { verbs: ["list", "get"] });
// The update grant covers name, slug and type; the parent changes only through partner setup.
const organizations = tableResource("organizations", {
  verbs: ["list", "get", "update"],
  fixed: ["parent_org_id"],
});

// External account memberships change only through app.add_account_member,
// app.end_account_membership and app.remove_account_role (0710): callers hold no write grant.
const accountMemberships = tableResource("accountMemberships", { verbs: ["list", "get"] });
const accountMembershipRoles = tableResource("accountMembershipRoles", { verbs: ["list", "get"] });

/** The caller's live membership in the active organization. */
async function myMembership(context: RequestContext): Promise<Membership> {
  const row = await run<Row | null>(
    from(context.db, "memberships")
      .select(memberships.fields.join(","))
      .eq("org_id", requireOrg(context).id)
      .eq("person_id", requirePerson(context))
      .is("deleted_at", null)
      .order("valid_from", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  if (row === null) throw notFound("You hold no membership in the active organization.");
  return row as Membership;
}

async function count(context: RequestContext, table: string, column: string, value: string) {
  const rows = await run<unknown[]>(
    from(context.db, table).select("id").eq(column, value).is("deleted_at", null),
  );
  return rows.length;
}

export const identityParity = {
  "me.get": async (_request, context) => {
    const personId = requirePerson(context);
    const [membershipCount, engagementCount] = await Promise.all([
      count(context, "memberships", "person_id", personId),
      count(context, "engagements", "person_id", personId),
    ]);
    return ok({
      person_id: personId,
      active_organization_id: context.org?.id ?? null,
      membership_count: membershipCount,
      engagement_count: engagementCount,
    });
  },

  ...handlersFor("Identity", tableResource("people", { verbs: ["list", "get", "update"] })),

  ...handlersFor("Identity", organizations),
  "organizations.create": async ({ body }, context) => {
    const { orgId } = unwrap(await createOrganization(context.db, body));
    return created((await organizations.read(context, orgId)) as Components["Organization"]);
  },
  "organizations.createClient": async ({ body }, context) => {
    const rows = await run<{ org_id: string; invite_id: string; invite_token: string }[]>(
      rpc(context.db, "create_client_organization", {
        p_partner_org_id: requireOrg(context).id,
        p_name: body.name,
        p_slug: body.slug,
        p_owner_email: body.owner_email,
        ...(body.plan_code === undefined ? {} : { p_plan_code: body.plan_code }),
      }),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("create_client_organization returned no row.");
    return created({
      org_id: row.org_id,
      invite_id: row.invite_id,
      invite_token: row.invite_token,
    });
  },

  ...handlersFor("Identity", memberships),
  "memberships.leave": async (_request, context) => {
    const current = await myMembership(context);
    unwrap(await leaveOrganization(context.db, requireOrg(context).id));
    const after = await run<Row | null>(
      from(context.db, "memberships")
        .select(memberships.fields.join(","))
        .eq("id", current.id)
        .maybeSingle(),
    );
    // Leaving can end the caller's own read access; the ended row is then the one they held.
    return ok((after ?? { ...current, valid_to: new Date().toISOString() }) as Membership);
  },
  "memberships.end": async ({ params }, context) => {
    await memberships.read(context, params.id, ["id"]);
    unwrap(await endMembership(context.db, params.id));
    return ok((await memberships.read(context, params.id)) as Membership);
  },
  // Ending a membership opens its offboarding checklist (private.open_offboarding, 0861).
  "memberships.offboard": async ({ params }, context) => {
    await memberships.read(context, params.id, ["id"]);
    unwrap(await endMembership(context.db, params.id));
    return ok((await memberships.read(context, params.id)) as Membership);
  },

  // The insert grant covers membership_id and role_id; the database derives org_id.
  ...handlersFor("Identity", tableResource("membershipRoles", { orgColumn: false })),
  ...handlersFor("Identity", tableResource("projectAssignments")),
  ...handlersFor("Identity", accountMemberships),
  "accountMemberships.delete": async ({ params }, context) => {
    await accountMemberships.read(context, params.id, ["id"]);
    unwrap(await endAccountMembership(context.db, params.id));
    return noContent();
  },
  ...handlersFor("Identity", accountMembershipRoles),
  // Granting a role adds it to the person's membership of the account (app.add_account_member).
  "accountMembershipRoles.create": async ({ body }, context) => {
    const membership = await run<{ org_id: string; person_id: string } | null>(
      from(context.db, "account_memberships")
        .select("org_id, person_id")
        .eq("id", body.account_membership_id)
        .is("deleted_at", null)
        .maybeSingle(),
    );
    if (membership === null) {
      throw notFound("No account membership with this identifier is visible to you.");
    }
    unwrap(
      await addAccountMember(context.db, {
        accountId: membership.org_id,
        personId: membership.person_id,
        role: body.account_role,
      }),
    );
    const role = await run<{ id: string } | null>(
      from(context.db, "account_membership_roles")
        .select("id")
        .eq("account_membership_id", body.account_membership_id)
        .eq("account_role", body.account_role)
        .is("deleted_at", null)
        .maybeSingle(),
    );
    if (role === null) throw notFound("The granted role is not visible to you.");
    return created((await accountMembershipRoles.read(context, role.id)) as never);
  },
  "accountMembershipRoles.delete": async ({ params }, context) => {
    await accountMembershipRoles.read(context, params.id, ["id"]);
    unwrap(await removeAccountRole(context.db, params.id));
    return noContent();
  },

  ...handlersFor("Identity", representations),
  "representations.create": async ({ body }, context) => {
    const { representationId } = unwrap(
      await proposeRepresentation(context.db, {
        accountId: requireOrg(context).id,
        artistPersonId: body.artist_person_id,
        representativePersonId: body.representative_person_id ?? null,
        expiresOn: body.expires_on,
        scopes: body.scopes,
      }),
    );
    return created((await representations.read(context, representationId)) as never);
  },
  // A representation is never deleted; removing it revokes it at once (app.revoke_representation).
  "representations.delete": async ({ params }, context) => {
    await representations.read(context, params.id, ["id"]);
    unwrap(await revokeRepresentation(context.db, params.id));
    return noContent();
  },
  "representations.accept": async ({ params }, context) => {
    await representations.read(context, params.id, ["id"]);
    unwrap(await acceptRepresentation(context.db, params.id));
    return ok((await representations.read(context, params.id)) as never);
  },

  ...handlersFor("Identity", invites),
  "invites.create": async ({ body }, context) => {
    const invite = unwrap(
      await inviteMember(context.db, {
        orgId: requireOrg(context).id,
        email: body.email,
        roleId: body.role_id,
        ...(body.valid_for_hours === undefined ? {} : { validForHours: body.valid_for_hours }),
      }),
    );
    return created({ invite_id: invite.inviteId, invite_token: invite.token });
  },
  // Removing a pending invite revokes it; the row stays for the audit trail.
  "invites.delete": async ({ params }, context) => {
    await invites.read(context, params.id, ["id"]);
    unwrap(await revokeInvite(context.db, params.id));
    return noContent();
  },
  "invites.preview": async ({ body }, context) => {
    const preview = unwrap(await previewInvite(context.db, body.token));
    return ok({
      org_name: preview.orgName,
      role_code: preview.roleCode,
      role_name: preview.roleName ?? preview.roleCode,
      expires_at: preview.expiresAt,
    });
  },
  "invites.accept": async ({ body }, context) => {
    const accepted = unwrap(await acceptInvite(context.db, body.token));
    return ok({ membership_id: accepted.membershipId });
  },

  ...handlersFor("Identity", tableResource("verifiedDomains")),
  ...handlersFor("Identity", tableResource("profileVisibilityRules")),
  // Verifications are recorded by the verification service (service role only); callers read them.
  ...handlersFor("Identity", tableResource("verifications", { verbs: ["list", "get"] })),
} satisfies HandlerSet<"Identity">;
