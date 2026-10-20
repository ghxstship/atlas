/**
 * Identity operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Identity resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Identity resources follow ADR 0023.
 */
import { z } from "@hono/zod-openapi";
import { AccountRole, OrgRole, fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, removeActions, removeVerbs, setTable } from "../correct.ts";
import {
  workDetailCapabilities,
  workDetailCorrections,
  workDetailResources,
} from "./parts/work-details.ts";

/** A profile handle as app.person_profiles and app.organization_profiles store it (0860). */
const handle = {
  schema: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/)
    .meta({
      description:
        "Unique handle for /u/{handle} or /c/{handle}: 3 to 40 lowercase letters, digits and single hyphens. Changeable once every 30 days; the old handle redirects for 90 days.",
      example: "northwind-live",
    }),
  update: true,
};
const handleChangedAt = {
  schema: orNull(
    fields.instant(
      "When the handle last changed; null until the first change. Set by the database.",
    ),
  ),
};

const A50 = "1.0.0-draft.2";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

const TITLE_CASE = /^[A-Z0-9][A-Za-z0-9&'/.()-]*( [A-Za-z0-9&'/.()-]+)*$/;

export const additions = defineAdditions("Identity", {
  resources: [...workDetailResources],
  capabilities: { ...workDetailCapabilities },
  corrections: [
    ...workDetailCorrections,
    {
      id: "person-full-name",
      since: "1.0.0-draft.2",
      resources: ["people"],
      change:
        "`name` becomes the nullable `full_name`; removes `preferred_name`, `primary_email`, `locale` and `time_zone`.",
      reason:
        "app.people (0202) stores only `full_name` (NULL until the person gives it); the sign-in email lives in Supabase Auth, which callers acting through row level security cannot read, and locale and time zone are personal settings (app.personal_setting_values, 0850).",
      apply: editShape({
        rename: { name: "full_name" },
        nullable: ["full_name"],
        remove: ["preferred_name", "primary_email", "locale", "time_zone"],
      }),
    },
    {
      id: "organization-type",
      since: "1.0.0-draft.2",
      resources: ["organizations"],
      change:
        "Adds `organization_type`; removes `legal_name`, `is_tenant`, `base_currency` and `country`.",
      reason:
        "app.organizations (0202) has a NOT NULL `organization_type` (canon xpms.organization_type, decision D17) and no legal name, tenant flag, base currency or country columns; legal entities and the default currency are settings of the organization.",
      apply: editShape({
        remove: ["legal_name", "is_tenant", "base_currency", "country"],
        add: {
          organization_type: {
            schema: z.string().regex(TITLE_CASE).meta({
              description:
                "Legal form from `xpms.organization_type` (decision D17): For-Profit, Nonprofit or Public Agency. It decides which worker classifications engagements may use.",
              example: "For-Profit",
            }),
            update: true,
          },
        },
      }),
    },
    {
      id: "membership-persona-removed",
      since: "1.0.0-draft.2",
      resources: ["memberships"],
      change: "Removes `persona` from the membership read shape.",
      reason:
        "app.memberships (0202) has no persona column: what a member sees follows from their roles and capabilities.",
      apply: editShape({ remove: ["persona"] }),
    },
    {
      id: "membership-role-id",
      since: "1.0.0-draft.2",
      resources: ["membershipRoles"],
      change:
        "`role` and `custom_role_id` become one `role_id` (system or custom role); adds the server-set `granted_by`.",
      reason:
        "app.membership_roles (0202) references app.roles by `role_id` for system and custom roles alike, and records who is accountable for the grant in `granted_by`.",
      apply: editShape({
        remove: ["role", "custom_role_id"],
        add: {
          role_id: {
            schema: fields.ref("held role: a system role or a custom role of the same org"),
            create: "required",
            update: false,
          },
          granted_by: {
            schema: orNull(
              fields.ref(
                "person accountable for the grant; null when the platform granted the first Owner of a new org",
              ),
            ),
          },
        },
      }),
    },
    {
      id: "account-membership-org",
      since: "1.0.0-draft.2",
      resources: ["accountMemberships"],
      change: "Removes `organization_id`; `valid_from` becomes optional on create.",
      reason:
        "app.account_memberships (0710) belongs to the external account through `org_id`, so a second organization field has no column, and `valid_from` defaults to now.",
      apply: editShape({ remove: ["organization_id"], optionalOnCreate: ["valid_from"] }),
    },
    {
      id: "account-membership-role",
      since: "1.0.0-draft.2",
      resources: ["accountMembershipRoles"],
      change: "`role` becomes `account_role`; adds the server-set `granted_by`.",
      reason:
        "app.account_membership_roles (0710) names the role column `account_role` (app.account_role) and records the granting person.",
      apply: editShape({
        remove: ["role"],
        add: {
          account_role: {
            schema: AccountRole,
            create: "required",
            update: false,
          },
          granted_by: {
            schema: orNull(
              fields.ref(
                "person who granted the role; null for the creator's own Account Owner role",
              ),
            ),
          },
        },
      }),
    },
    {
      id: "representation-person",
      since: "1.0.0-draft.2",
      resources: ["representations"],
      change:
        "Removes `representative_organization_id`; `representative_person_id` becomes nullable; adds the server-set `revoked_at`.",
      reason:
        "app.representations (0710) names the representative person (NULL while the agency has not named one) and records revocation in `revoked_at`; it has no representative organization column. Scopes stay, read from app.representation_scopes.",
      apply: editShape({
        nullable: ["representative_person_id"],
        remove: ["representative_organization_id"],
        add: {
          revoked_at: {
            schema: orNull(fields.instant("When the artist or the account revoked it.")),
          },
        },
      }),
    },
    {
      id: "invite-acceptance",
      since: "1.0.0-draft.2",
      resources: ["invites"],
      change: "Adds `partner_bootstrap` and `accepted_person_id`.",
      reason:
        "app.invites (0202) marks the first Owner invite a partner issues for a client org (`partner_bootstrap`) and records who accepted (`accepted_person_id`).",
      apply: editShape({
        add: {
          partner_bootstrap: {
            schema: fields.bool(
              "True for the first Owner invite a partner issues when it creates a client org (Section 4.6.1).",
              false,
            ),
          },
          accepted_person_id: { schema: orNull(fields.ref("person who accepted")) },
        },
      }),
    },
    {
      id: "project-assignment-members",
      since: "1.0.0-draft.2",
      resources: ["projectAssignments"],
      change:
        "The resource reads `app.project_members`: `person_id` becomes `membership_id`, adds `project_role`, and `valid_from` and `valid_to` are instants (`valid_from` optional on create).",
      reason:
        "Project assignments are app.project_members (0301): a project role for an org membership, valid between two timestamps, with `valid_from` defaulting to now.",
      apply: all(
        setTable("app.project_members"),
        editShape({
          remove: ["person_id"],
          add: {
            membership_id: {
              schema: fields.ref("org membership of the person, in the project's org"),
              create: "required",
              update: false,
            },
            project_role: {
              schema: label(
                ["Producer", "Department Head", "Coordinator", "Field Supervisor", "Field"],
                "Project role.",
              ),
              create: "required",
            },
            valid_from: {
              schema: fields.instant("When the assignment starts."),
              create: "optional",
            },
            valid_to: {
              schema: orNull(fields.instant("When the assignment ends; null while open.")),
              create: "optional",
            },
          },
        }),
      ),
    },
    {
      id: "verified-domain-org-domains",
      since: "1.0.0-draft.2",
      resources: ["verifiedDomains"],
      change:
        "The resource reads `app.org_domains`: `domain` becomes `hostname`, adds `purpose`, the server-set `verification_state`, `verification_token` and `last_checked_at`, and `auto_join_role_id` replaces `auto_join` and `default_role`; removes `verified_at`.",
      reason:
        "Domains are app.org_domains (0850): a host name with a purpose, a DNS verification state changed only by app.record_domain_verification, a token to publish, and an optional role for automatic join (NULL turns it off).",
      apply: all(
        setTable("app.org_domains"),
        editShape({
          rename: { domain: "hostname" },
          remove: ["auto_join", "default_role", "verified_at"],
          add: {
            hostname: {
              schema: fields.text(
                "Lowercase host name, for example gateway.northwindlive.example.",
                "gateway.northwindlive.example",
                253,
              ),
              create: "required",
              update: false,
            },
            purpose: {
              schema: label(
                ["Atlas", "Gateway", "Email Sending", "Verified Domain"],
                "What the domain is for.",
              ),
              create: "required",
              update: false,
            },
            verification_state: {
              schema: label(
                ["Pending", "Verified", "Failed"],
                "DNS verification state; changed only by app.record_domain_verification.",
              ),
            },
            verification_token: {
              schema: fields.text(
                "Value the org publishes in a DNS TXT record to prove control.",
                "xos-verify=6f1c2d",
              ),
            },
            last_checked_at: {
              schema: orNull(fields.instant("When the verification service last checked DNS.")),
            },
            auto_join_role_id: {
              schema: orNull(
                fields.ref(
                  "role a person with a confirmed address at this verified domain receives on joining automatically; null turns automatic join off",
                ),
              ),
              create: "optional",
            },
          },
        }),
      ),
    },
    {
      id: "verification-organization",
      since: "1.0.0-draft.2",
      resources: ["verifications"],
      change:
        "The resource reads `app.organization_verifications`: a verification has a `method`, a `provider_reference`, `expires_at`, and the server-set `revoked_at` and `revocation_reason`; removes `owner_urn`, `claim` and `verifier`.",
      reason:
        "Verifications are app.organization_verifications (0860): an organization verified by Stripe Identity or a business registry, with the provider's reference, an optional expiry and platform revocation; there is no generic owner or claim column.",
      apply: all(
        setTable("app.organization_verifications"),
        editShape({
          remove: ["owner_urn", "claim", "verifier"],
          add: {
            method: {
              schema: label(
                ["Stripe Identity", "Business Registry"],
                "How the organization was verified.",
              ),
              create: "required",
            },
            provider_reference: {
              schema: fields.text(
                "The provider's verification or registry record reference.",
                "vs_1Pq2Rs3Tu4",
              ),
              create: "required",
            },
            expires_at: {
              schema: orNull(
                fields.instant("When the verification lapses; null when it does not."),
              ),
              create: "optional",
            },
            revoked_at: { schema: orNull(fields.instant("When the platform revoked it.")) },
            revocation_reason: {
              schema: orNull(fields.longText("Why it was revoked.", "The registry record lapsed.")),
            },
          },
        }),
      ),
    },
    {
      id: "profile-visibility-sections",
      since: "1.0.0-draft.2",
      resources: ["profileVisibilityRules"],
      change:
        "The resource reads `app.profile_section_visibility`: a rule is a `person_id`, a `section` and its `visibility`; removes `owner_urn`, `target` and `level`.",
      reason:
        "Profile visibility is app.profile_section_visibility (0860): one row per person and profile section with Private, Network or Public.",
      apply: all(
        setTable("app.profile_section_visibility"),
        editShape({
          remove: ["owner_urn", "target", "level"],
          add: {
            person_id: { schema: fields.ref("profile owner"), create: "required", update: false },
            section: {
              schema: label(
                [
                  "photo",
                  "pronouns",
                  "headline",
                  "bio",
                  "location",
                  "skills",
                  "certifications",
                  "portfolio",
                  "rates",
                  "availability",
                  "languages",
                  "references",
                  "links",
                  "organizations",
                ],
                "Profile section.",
              ),
              create: "required",
              update: false,
            },
            visibility: {
              schema: label(["Private", "Network", "Public"], "Visibility chosen for the section."),
              create: "required",
            },
          },
        }),
      ),
    },
    {
      id: "invitation-links-table",
      since: "1.0.0-draft.2",
      resources: ["invitationLinks"],
      components: ["schemas/OrgRole"],
      change:
        "The resource reads `app.invite_links`, and its nullable `role` references the OrgRole component as `anyOf` the role and null.",
      reason:
        "Invitation links are app.invite_links (0861); there is no app.invitation_links table, and the A30 handlers already read it. With `membershipRoles.role` gone, this field is the first reference to OrgRole, and its frozen `.nullable()` form would make the shared component itself nullable. The frozen document already rendered OrgRole as nullable from an earlier nullable reference; it is now the plain role enum, and nullable references stay nullable.",
      apply: all(
        setTable("app.invite_links"),
        editShape({
          add: { role: { schema: orNull(OrgRole), writeSchema: OrgRole, create: "required" } },
        }),
      ),
    },
    {
      id: "offboarding-checklists-table",
      since: "1.0.0-draft.2",
      resources: ["offboardingChecklists"],
      change: "The resource reads `app.offboardings`.",
      reason:
        "Offboarding checklists are app.offboardings (0861); there is no app.offboarding_checklists table. The A30 handlers already read it.",
      apply: setTable("app.offboardings"),
    },
    {
      id: "organization-create-returns-corrected-read",
      since: "1.0.0-draft.2",
      resources: ["organizations"],
      change:
        "`organizations.create` answers with the corrected Organization read shape (with `organization_type`, without `legal_name`, `is_tenant`, `base_currency` and `country`), and its example follows.",
      reason:
        "The action named the frozen read shape explicitly, so `organization-type` left its runtime response schema and example on columns app.organizations (0202) does not have; the created row is read back from app.organizations.",
      apply: (spec) => ({
        ...spec,
        actions: spec.actions.map((a) =>
          a.verb === "create" ? { ...a, response: spec.def.read } : a,
        ),
      }),
    },

    // A50 (gate 5, RRR-94, ADR 0032) ----------------------------------------------------------------
    {
      id: "membership-validity-through-rpcs",
      since: A50,
      resources: ["memberships"],
      change:
        "Removes `memberships.update`: a membership's validity changes only by ending it (`memberships.end`, `memberships.offboard`, `memberships.leave`).",
      reason:
        "app.memberships (0202) grants callers no update: `valid_from` is set when the membership is created through the join paths, and `valid_to` only by app.end_membership and app.leave_organization, which also open the offboarding checklist (0861). Decided in ADR 0032.",
      apply: removeVerbs("update"),
    },
    {
      id: "project-assignment-roles-table",
      since: A50,
      resources: ["projectAssignmentRoles"],
      change:
        "The resource reads `app.project_member_roles`: `project_assignment_id` becomes `project_member_id` and `role` becomes `project_role`. An assignment's lead role (`project_role` on the assignment) is always one of its rows and is removed only by changing the lead role.",
      reason:
        "Project assignments are app.project_members (0301, correction project-assignment-members); app.project_member_roles (1204, A52) holds every project role an assignment carries (Section 4.8.1: project roles, many), and project-role capabilities are the union over those rows. A person never adds a role to their own assignment (sod_self_grant). Amends ADR 0032, which had retired these operations.",
      apply: all(
        setTable("app.project_member_roles"),
        editShape({ rename: { project_assignment_id: "project_member_id", role: "project_role" } }),
      ),
    },
    {
      id: "account-membership-through-rpc",
      since: A50,
      resources: ["accountMemberships"],
      change:
        "Creating an account membership adds the person to the caller's external account with a required, write-only `account_role` (app.add_account_member); `valid_from` and `valid_to` are server-set. Removes `accountMemberships.update`.",
      reason:
        "app.account_memberships (0710) grants callers no insert or update: app.add_account_member opens the membership with its first role (an account membership always holds one), app.end_account_membership ends it, and roles change through accountMembershipRoles. Decided in ADR 0032.",
      apply: all(
        editShape({
          serverSet: ["valid_from", "valid_to"],
          add: { account_role: { schema: AccountRole, create: "required", read: false } },
        }),
        removeVerbs("update"),
      ),
    },
    {
      id: "organization-relationship-counterparties",
      since: A50,
      resources: ["organizationRelationships"],
      components: ["schemas/OrganizationRelationshipKind"],
      change:
        "The resource reads `app.counterparties`: `related_organization_id` becomes `organization_id` (fixed once created); `kind` and `internal_notes` are removed, and the `OrganizationRelationshipKind` component with them; `counterparty_type` accepts null.",
      reason:
        "The org-owned relationship row to another organization is app.counterparties (0301, Section 3.15 item 4): the other organization and its canon counterparty type, read by the org's members and written with vendors.vendor.write. It has no kind or notes column; whether the other organization is a vendor, a client or a represented party follows from its vendor facet, its projects and its representations.",
      apply: all(
        setTable("app.counterparties"),
        editShape({
          rename: { related_organization_id: "organization_id" },
          remove: ["kind", "internal_notes"],
          nullable: ["counterparty_type"],
          immutable: ["organization_id"],
        }),
      ),
    },
    {
      id: "representation-terms-accepted",
      since: A50,
      resources: ["representations"],
      change:
        "Removes `representations.update`: changing a representation's scopes or expiry is a new proposal that the artist accepts.",
      reason:
        "app.representations (0710) grants callers no update; its scopes and expiry are what the artist accepted (app.propose_representation, app.accept_representation). Changing them without a new acceptance would extend an agency's reach beyond the artist's consent, so a change revokes the representation and proposes a new one. Decided in ADR 0032.",
      apply: removeVerbs("update"),
    },
    {
      id: "verified-domain-service-check",
      since: A50,
      resources: ["verifiedDomains"],
      change:
        "Removes `verifiedDomains.verify`: the platform verification service checks each pending domain's DNS record and records the result.",
      reason:
        "app.record_domain_verification (0850) is granted to the service role only, and guard_org_domain refuses any other change to the verification fields, so no caller of the public API can mark a domain verified. Decided in ADR 0032.",
      apply: removeActions("verify"),
    },
    {
      id: "profile-sections-are-visibility-rules",
      since: A50,
      resources: ["profileSections"],
      change:
        "Removes every profileSections operation: a section's visibility is a profileVisibilityRules row.",
      reason:
        "Profile sections are the fixed list app.profile_section (0860), each shown in its product order; a section's own visibility, never higher than the profile, is app.profile_visibility (correction profile-visibility-sections). There is no app.profile_sections table, and a second one would store the same visibility twice (Section 3.15). Decided in ADR 0032.",
      apply: removeVerbs("list", "get", "create", "update", "delete"),
    },
    {
      id: "profile-handle-on-profile",
      since: A50,
      resources: ["profileHandles", "personProfiles", "organizationProfiles"],
      change:
        "Removes every profileHandles operation; person and organization profiles gain `handle` (changed on update) and the server-set `handle_changed_at`.",
      reason:
        "A handle is a column of app.person_profiles and app.organization_profiles (0860), issued with the profile and changed under guard_handle's 30-day rule with its 90-day redirect; there is no app.profile_handles table. Decided in ADR 0032.",
      apply: (spec) =>
        spec.op === "profileHandles"
          ? removeVerbs("list", "get", "create", "update")(spec)
          : editShape({ add: { handle, handle_changed_at: handleChangedAt } })(spec),
    },
    {
      id: "verification-recorded-by-provider",
      since: A50,
      resources: ["verifications"],
      change:
        "Removes `verifications.create`: a verification badge is recorded by the provider integration or the platform.",
      reason:
        "app.organization_verifications (0860) grants callers no insert: Section 4.8.3 shows a badge only after the platform or a provider (Stripe Identity, a business registry) checks the claim, and those record the result with the service role. Decided in ADR 0032.",
      apply: removeVerbs("create"),
    },
    {
      id: "blocks-enforced-on-profiles",
      since: A50,
      resources: ["blocks"],
      change:
        "Describes what a block does: it hides the blocker's profile from the blocked person and from every member of a blocked organization, and the blocked profile from the blocker. `blocked_urn` names a person or an organization.",
      reason:
        "app.blocks (1206, A52) stores a person's blocks, readable and writable only by them, and private.profile_visible_to_me and private.org_profile_visible_to_me, which every profile RPC calls, refuse a profile across a block. A block never ends a membership or an engagement. Amends ADR 0032, which had retired these operations until blocking was enforced.",
      apply: editShape({
        description:
          "A person's block of another person or an organization (Section 4.5.6 Profile Privacy). It hides the blocker's profile from the blocked person and from every member of a blocked organization, and the blocked profile from the blocker. Memberships and engagements are not affected.",
        add: {
          blocked_urn: {
            schema: fields.text(
              "URN of the blocked person (urn:xpms:person:{id}) or organization (urn:xpms:organization:{id}).",
              "urn:xpms:person:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
            ),
            create: "required",
            update: false,
          },
        },
      }),
    },
  ],
});
