/**
 * The canonical identity model and profiles (Sections 4.8 and 7.3 "Added in 1.6").
 * Names follow the Section 7.3 name mapping: `organizations`, `people`, `person_profiles`,
 * `account_memberships`, `membership_roles`.
 */
import { z } from "zod";
import * as c from "../common/canon-codes.ts";
import * as f from "../common/fields.ts";
import {
  AccountRole,
  OrganizationRelationshipKind,
  OrgRole,
  ProfileVisibility,
  ProjectRole,
  RepresentationScope,
} from "../common/enums.ts";
import { defineResource } from "../common/resource.ts";

export const Person = defineResource({
  name: "Person",
  table: "app.people",
  description: "One human, linked to one sign-in. Personal facts are owned by the person.",
  base: "global",
  fields: {
    name: f.text("Legal or full name.", "Alex Rivera"),
    preferred_name: f.text("Preferred name.", "Alex").nullable(),
    primary_email: f.email("Verified primary email."),
    locale: f.localeTag(),
    time_zone: f.timeZone("Home time zone."),
  },
});

export const Organization = defineResource({
  name: "Organization",
  table: "app.organizations",
  description:
    "Every company on the platform: a tenant (with a subscription), an external account, or both. A partner org cannot have a parent partner.",
  base: "global",
  serverSet: ["is_tenant"],
  fields: {
    name: f.text("Trade name.", "Northwind Live"),
    legal_name: f.text("Legal name.", "Northwind Live LLC").nullable(),
    slug: f.code("URL slug.", "northwind-live"),
    parent_org_id: f.ref("partner organization").nullable(),
    is_tenant: f.bool("Whether the organization holds a subscription and uses Atlas.", true),
    base_currency: f.currency("Base currency."),
    country: f.countryCode(),
  },
});

export const Subscription = defineResource({
  name: "Subscription",
  table: "app.subscriptions",
  description: "Present only when an organization uses Atlas: plan, billing and tenant settings.",
  serverSet: ["subscription_state", "current_period_end"],
  fields: {
    plan_code: f.code("Plan code from `plans.yaml`.", "pro"),
    subscription_state: f.stateLabel("Subscription lifecycle state.", "Active"),
    current_period_end: f.instant("End of the current billing period."),
    seats: f.int("Licensed seats.", 25, 1).nullable(),
  },
});

export const Plan = defineResource({
  name: "Plan",
  table: "app.plans",
  description: "A plan generated from `plans.yaml`.",
  base: "view",
  fields: {
    plan_code: f.code("Plan code.", "pro"),
    name: f.text("Plan name.", "Pro"),
    monthly_price_minor: f.money("Monthly price per seat.", 4900),
    currency: f.currency(),
  },
});

export const Membership = defineResource({
  name: "Membership",
  table: "app.memberships",
  description: "A person in an organization as an internal member, with time-boxed validity.",
  immutable: ["person_id"],
  fields: {
    person_id: f.ref("member"),
    valid_from: f.instant("Start of membership."),
    valid_to: f.instant("End of membership.").nullable(),
    persona: f.stateLabel("Primary persona.", "Producer").nullable(),
  },
});

export const MembershipRole = defineResource({
  name: "MembershipRole",
  table: "app.membership_roles",
  description:
    "A role held through a membership. A person may hold several; capabilities are the union. A person cannot grant themselves a role.",
  immutable: ["membership_id"],
  fields: {
    membership_id: f.ref("membership"),
    role: OrgRole.nullable(),
    custom_role_id: f.ref("custom role").nullable(),
  },
});

export const ProjectAssignment = defineResource({
  name: "ProjectAssignment",
  table: "app.project_assignments",
  description: "A person on a project, with scope nodes and dates.",
  immutable: ["project_id", "person_id"],
  fields: {
    project_id: f.ref("project"),
    person_id: f.ref("person"),
    valid_from: f.date("First day on the project."),
    valid_to: f.date("Last day on the project.").nullable(),
  },
});

export const ProjectAssignmentRole = defineResource({
  name: "ProjectAssignmentRole",
  table: "app.project_assignment_roles",
  description: "A project role held through a project assignment.",
  immutable: ["project_assignment_id", "role"],
  fields: { project_assignment_id: f.ref("project assignment"), role: ProjectRole },
});

export const AccountMembership = defineResource({
  name: "AccountMembership",
  table: "app.account_memberships",
  description: "A person in an external organization's account.",
  base: "global",
  immutable: ["organization_id", "person_id"],
  fields: {
    organization_id: f.ref("external account organization"),
    person_id: f.ref("member"),
    valid_from: f.instant("Start of account membership."),
    valid_to: f.instant("End of account membership.").nullable(),
  },
});

export const AccountMembershipRole = defineResource({
  name: "AccountMembershipRole",
  table: "app.account_membership_roles",
  description: "An account role held through an account membership.",
  base: "global",
  immutable: ["account_membership_id", "role"],
  fields: { account_membership_id: f.ref("account membership"), role: AccountRole },
});

export const OrganizationRelationship = defineResource({
  name: "OrganizationRelationship",
  table: "app.organization_relationships",
  description:
    "One organization's relationship to another, with the org-owned facts. Never visible to another org.",
  immutable: ["related_organization_id", "kind"],
  fields: {
    related_organization_id: f.ref("related organization"),
    kind: OrganizationRelationshipKind,
    counterparty_type: c.CounterpartyType.nullable(),
    internal_notes: f.longText("Internal notes.", "Preferred staging supplier.").nullable(),
  },
});

export const Representation = defineResource({
  name: "Representation",
  table: "app.representations",
  description: "One party acting for another, with scopes and expiry. The artist accepts it.",
  base: "global",
  immutable: ["representative_person_id", "artist_person_id"],
  serverSet: ["accepted_at"],
  fields: {
    representative_person_id: f.ref("representative"),
    representative_organization_id: f.ref("agency or management company").nullable(),
    artist_person_id: f.ref("represented artist"),
    scopes: z.array(RepresentationScope).meta({
      description: "Delegated scopes, stored as junction rows.",
      example: ["Offers", "Advance"],
    }),
    expires_on: f.date("Expiry."),
    accepted_at: f.instant("When the artist accepted.").nullable(),
  },
});

export const JoinRequest = defineResource({
  name: "JoinRequest",
  table: "app.join_requests",
  description: "A request to join an org, approved by an Admin.",
  immutable: ["person_id"],
  serverSet: ["join_request_state", "decided_by"],
  fields: {
    person_id: f.ref("requesting person"),
    message: f.longText("Message to the admins.", "I run audio for the summer series.").nullable(),
    join_request_state: f.stateLabel("Request state.", "Proposed"),
    decided_by: f.ref("deciding admin").nullable(),
  },
});

export const InvitationLink = defineResource({
  name: "InvitationLink",
  table: "app.invitation_links",
  description: "An invitation link with a role and an expiry. The token is shown once.",
  serverSet: ["revoked_at"],
  fields: {
    role: OrgRole,
    expires_at: f.instant("When the link expires."),
    max_uses: f.int("Maximum uses.", 10, 1).nullable(),
    revoked_at: f.instant("When the link was revoked.").nullable(),
  },
});

export const Invite = defineResource({
  name: "Invite",
  table: "app.invites",
  description:
    "An email invitation to join an org. Created through `invites.create` (the `app.invite_member` RPC); the token is never stored or returned again.",
  serverSet: ["email", "role_id", "expires_at", "invited_by", "accepted_at", "revoked_at"],
  fields: {
    email: f.email("Invitee email."),
    role_id: f.ref("role offered"),
    expires_at: f.instant("When the invite expires."),
    invited_by: f.ref("inviting person"),
    accepted_at: f.instant("When it was accepted.").nullable(),
    revoked_at: f.instant("When it was revoked or replaced.").nullable(),
  },
});

export const VerifiedDomain = defineResource({
  name: "VerifiedDomain",
  table: "app.verified_domains",
  description: "A verified email domain with automatic join and a default role.",
  serverSet: ["verified_at"],
  fields: {
    domain: f.text("Domain.", "northwindlive.example"),
    auto_join: f.bool("Whether verified emails join automatically.", true),
    default_role: OrgRole,
    verified_at: f.instant("When the domain was verified.").nullable(),
  },
});

export const OffboardingChecklist = defineResource({
  name: "OffboardingChecklist",
  table: "app.offboarding_checklists",
  description: "The checklist that reassigns a departing member's open records.",
  immutable: ["membership_id"],
  serverSet: ["open_record_count", "completed_at"],
  fields: {
    membership_id: f.ref("ending membership"),
    reassign_to_person_id: f.ref("default reassignee").nullable(),
    open_record_count: f.int("Open records still assigned.", 4),
    completed_at: f.instant("When offboarding completed.").nullable(),
  },
});

export const PersonProfile = defineResource({
  name: "PersonProfile",
  table: "app.person_profiles",
  description: "A person's profile page, owned by the person. New profiles start Private.",
  base: "global",
  immutable: ["person_id"],
  fields: {
    person_id: f.ref("person"),
    headline: f.text("Headline.", "Head Rigger, Festivals and Arenas").nullable(),
    bio: f.longText("Bio.", "Fifteen years rigging touring shows.").nullable(),
    pronouns: f.text("Pronouns, optional.", "they/them").nullable(),
    locality: f.text("City.", "Miami").nullable(),
    country: f.countryCode().nullable(),
    visibility: ProfileVisibility,
    search_indexing: f.bool("Whether search engines may index a public profile.", false),
  },
});

export const OrganizationProfile = defineResource({
  name: "OrganizationProfile",
  table: "app.organization_profiles",
  description: "An organization's profile page. New organizations start Network.",
  base: "global",
  immutable: ["organization_id"],
  fields: {
    organization_id: f.ref("organization"),
    about: f.longText("About.", "Live event production for waterfront venues.").nullable(),
    visibility: ProfileVisibility,
    search_indexing: f.bool("Whether search engines may index a public profile.", false),
  },
});

export const ProfileSection = defineResource({
  name: "ProfileSection",
  table: "app.profile_sections",
  description:
    "A section of a profile page with its own visibility, never higher than the profile.",
  base: "global",
  fields: {
    owner_urn: f.text(
      "URN of the profile owner.",
      "urn:xpms:person:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    section_key: f.code("Section key.", "certifications"),
    position: f.int("Display order.", 3, 1),
    visibility: ProfileVisibility,
  },
});

export const ProfileVisibilityRule = defineResource({
  name: "ProfileVisibilityRule",
  table: "app.profile_visibility",
  description:
    "Visibility of one profile section or field. It can be lower than the profile, never higher.",
  base: "global",
  fields: {
    owner_urn: f.text(
      "URN of the profile owner.",
      "urn:xpms:person:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    target: f.code("Section or field key.", "rates"),
    level: ProfileVisibility,
  },
});

export const ProfileHandle = defineResource({
  name: "ProfileHandle",
  table: "app.profile_handles",
  description: "A unique profile handle, changeable once every 30 days, with 90-day redirects.",
  base: "global",
  serverSet: ["changed_at"],
  fields: {
    owner_urn: f.text(
      "URN of the profile owner.",
      "urn:xpms:person:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    handle: f.code("Handle.", "alex-rivera"),
    changed_at: f.instant("When the handle last changed."),
  },
});

export const Verification = defineResource({
  name: "Verification",
  table: "app.verifications",
  description:
    "A verification badge, shown only after the platform or a provider checks the claim.",
  base: "global",
  serverSet: ["verified_at", "verifier"],
  fields: {
    owner_urn: f.text(
      "URN of the verified profile.",
      "urn:xpms:organization:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    claim: f.stateLabel("What is verified.", "Business Identity"),
    verifier: f.code("Who verified it.", "stripe_identity"),
    verified_at: f.instant("When it was verified.").nullable(),
  },
});

export const Block = defineResource({
  name: "Block",
  table: "app.blocks",
  description: "A block between two profiles.",
  base: "global",
  immutable: ["blocked_urn"],
  fields: {
    blocked_urn: f.text(
      "URN of the blocked profile.",
      "urn:xpms:person:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
  },
});

export const Me = defineResource({
  name: "Me",
  table: "app.v_me",
  description: "The caller: person, memberships, engagements and the active context.",
  base: "view",
  fields: {
    person_id: f.ref("calling person"),
    active_organization_id: f.ref("organization the credential is bound to").nullable(),
    membership_count: f.int("Internal memberships held.", 2),
    engagement_count: f.int("External engagements held.", 5),
  },
});

// Requests and results of the identity RPCs (migration 0206, ADR 0008).

const slug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/)
  .meta({
    description: "URL slug; reserved and taken slugs are refused.",
    example: "northwind-live",
  });

const inviteToken = z.string().min(1).meta({
  description: "Invite token from the invitation email. Sent in the body, never in a URL.",
  example: "xinv_3f9a1c0d7e2b4a6f8c1d0e9b7a5c3f1e",
});

export const CreateOrganizationRequest = z
  .object({ name: f.text("Organization name.", "Northwind Live"), slug })
  .meta({
    id: "CreateOrganizationRequest",
    description: "Creates an organization on the Access plan with the caller as its Owner.",
  });

export const CreateClientOrganizationRequest = z
  .object({
    name: f.text("Client organization name.", "Harbor City Events"),
    slug,
    owner_email: f.email("Email of the client's first Owner, who receives an invite."),
    plan_code: f.code("Plan code from `plans.yaml`; defaults to access.", "access").optional(),
  })
  .meta({
    id: "CreateClientOrganizationRequest",
    description:
      "Creates a client organization under the caller's partner organization (Section 4.6.1).",
  });

export const CreateClientOrganizationResult = z
  .object({
    org_id: f.ref("client organization"),
    invite_id: f.ref("Owner invite"),
    invite_token: inviteToken,
  })
  .meta({
    id: "CreateClientOrganizationResult",
    description: "The created client org and its Owner invite. The token is shown once.",
  });

export const InviteMemberRequest = z
  .object({
    email: f.email("Invitee email."),
    role_id: f.ref("role offered, at or below the inviter's band"),
    valid_for_hours: z.int().min(1).max(720).optional().meta({
      description: "Hours until the invite expires, from 1 to 720. Default 336 (14 days).",
      example: 336,
    }),
  })
  .meta({
    id: "InviteMemberRequest",
    description:
      "Invites an email to the caller's organization, replacing any pending invite for it.",
  });

export const InviteMemberResult = z
  .object({ invite_id: f.ref("invite"), invite_token: inviteToken })
  .meta({
    id: "InviteMemberResult",
    description: "The created invite. The token is shown once; only its hash is stored.",
  });

export const InviteTokenRequest = z
  .object({ token: inviteToken })
  .meta({ id: "InviteTokenRequest", description: "An invite token presented by its recipient." });

export const InvitePreview = z
  .object({
    org_name: f.text("Organization the invite joins.", "Northwind Live"),
    role_code: f.code("Offered role code.", "member"),
    role_name: f.text("Offered role name.", "Member"),
    expires_at: f.instant("When the invite expires."),
  })
  .meta({
    id: "InvitePreview",
    description: "What an invite offers, shown only to its confirmed recipient.",
  });

export const AcceptInviteResult = z
  .object({ membership_id: f.ref("membership joined or reused") })
  .meta({ id: "AcceptInviteResult", description: "The membership the accepted invite joined." });
