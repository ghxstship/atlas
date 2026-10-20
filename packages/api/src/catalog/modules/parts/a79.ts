/**
 * A79 org lifecycle (migrations 1350 to 1355; Section 4.6.1, Section 12, Section 14.7): ownership transfers,
 * deletion requests with their 7-day recovery window, deletion certificates, standing partner grants, leaving
 * a partner, checking a custom domain again, and the trial end on subscriptions. catalog/modules/platform.ts,
 * identity.ts and settings.ts spread them into their additions. Additive, apart from the draft corrections
 * listed with their reasons (ADR 0023).
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, editShape, orNull } from "../../correct.ts";
import type { CorrectionInput } from "../../corrections.ts";
import { collectionAction, itemAction, resource } from "../../define.ts";
import type { ActionSpec, ResourceSpec } from "../../types.ts";

const SINCE = "1.0.0-draft.2";

/** Audit people are nullable on every resource (ADR 0023): seed and platform rows carry none. */
const audited = (def: Parameters<typeof editDefinition>[0]) =>
  editDefinition(def, { nullable: ["created_by", "updated_by"] });

const OwnershipTransfer = audited(
  defineResource({
    name: "OwnershipTransfer",
    table: "app.ownership_transfers",
    description:
      "An Owner's offer to hand the org to another active member (1352, Section 14.7). The member accepts with step-up (a second factor) within 7 days; the old Owner then becomes an Admin, or leaves, and the org keeps an Owner at every step. Written only by the transfer actions; audited.",
    fields: {
      from_person_id: fields.ref("Owner who offered the org"),
      to_person_id: fields.ref("member the org is offered to"),
      previous_owner_outcome: z
        .enum(["admin", "leave"])
        .meta({
          description: "What happens to the Owner who offered on acceptance.",
          example: "admin",
        }),
      offered_at: fields.instant("When the offer was made."),
      expires_at: fields.instant("When an unanswered offer lapses, 7 days after it was made."),
      accepted_at: fields.instant("When the member accepted and became an Owner.").nullable(),
      declined_at: fields.instant("When the member declined.").nullable(),
      canceled_at: fields.instant("When an Owner withdrew the offer.").nullable(),
      canceled_by: fields.ref("Owner who withdrew it").nullable(),
      expired_at: fields.instant("When the lifecycle job lapsed the unanswered offer.").nullable(),
    },
    serverSet: [
      "from_person_id",
      "offered_at",
      "expires_at",
      "accepted_at",
      "declined_at",
      "canceled_at",
      "canceled_by",
      "expired_at",
    ],
  }),
);

const OrgDeletionRequest = audited(
  defineResource({
    name: "OrgDeletionRequest",
    table: "app.org_deletion_requests",
    description:
      "An Owner's request to delete the org (1351, Section 14.7), separate from cancellation: made with step-up and the typed name, it ends the subscription and makes the org read-only at once; an Owner may recover it for 7 days, after which the data is deleted and the Owner receives a deletion certificate.",
    fields: {
      reason: fields.longText(
        "Why the org is deleted, in the Owner's words.",
        "We are closing down.",
      ),
      requested_at: fields.instant("When the Owner asked for deletion."),
      recover_until: fields.instant("End of the 7-day recovery window."),
      requested_by: fields.ref("Owner who asked for deletion"),
      recovered_at: fields.instant("When an Owner recovered the org.").nullable(),
      recovered_by: fields.ref("Owner who recovered it").nullable(),
    },
    serverSet: ["requested_at", "recover_until", "requested_by", "recovered_at", "recovered_by"],
  }),
);

const DeletionCertificate = defineResource({
  name: "DeletionCertificate",
  table: "app.deletion_certificates",
  description:
    "The record of an org whose data was deleted (1351, Section 14.7), kept after the org is gone. Read only by the former Owner it was issued to. The PDF itself is downloaded from Atlas.",
  base: "global",
  fields: {
    deleted_org_id: fields.uuid("Id the deleted org had."),
    org_name: fields.text("Name of the org when it was deleted.", "Harbor Lights Productions"),
    org_slug: fields.text("Web address of the org when it was deleted.", "harbor-lights", 100),
    basis: z
      .enum(["cancellation", "deletion_request"])
      .meta({
        description:
          "Day 90 of a cancellation, or the end of a deletion request's recovery window.",
        example: "cancellation",
      }),
    requested_at: fields.instant("When the Owner canceled or asked for deletion."),
    due_at: fields.instant("When the data became due for deletion."),
    purged_at: fields.instant("When every row of the org was deleted.").nullable(),
    tables_purged: fields.int("Tables rows were deleted from.", 41, 0).nullable(),
    rows_purged: fields.int("Rows deleted.", 1820, 0).nullable(),
    storage_objects_deleted: fields.int("Stored files deleted.", 12, 0),
    document_sha256: fields
      .text(
        "SHA-256 of the certificate PDF.",
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        64,
      )
      .nullable(),
    issued_at: fields.instant("When the certificate PDF was stored.").nullable(),
    delivered_at: fields
      .instant("When the certificate was emailed to the former Owner.")
      .nullable(),
  },
  serverSet: [
    "deleted_org_id",
    "org_name",
    "org_slug",
    "basis",
    "requested_at",
    "due_at",
    "purged_at",
    "tables_purged",
    "rows_purged",
    "storage_objects_deleted",
    "document_sha256",
    "issued_at",
    "delivered_at",
  ],
});

const PartnerStandingGrant = audited(
  defineResource({
    name: "PartnerStandingGrant",
    table: "app.partner_standing_grants",
    description:
      "A standing grant of the partner and client agreement (1354, Section 4.6.1): the client Owner lets the partner's staff read one area of the client org until an expiry within a year, citing the clause. Each issues an org-level record grant; either side may end it early. Partner staff never write through one.",
    fields: {
      partner_org_id: fields.ref("partner org whose staff may read"),
      capability_code: fields.code(
        "The scope: one read capability a support session may grant.",
        "org.settings.read",
      ),
      agreement_reference: fields.text(
        "The clause of the agreement that provides the grant.",
        "Partner agreement, clause 7.2",
      ),
      valid_from: fields.instant("When access began."),
      valid_to: fields.instant("When access ends on its own."),
      record_grant_id: fields.ref("org-level record grant the standing grant issued"),
      ended_at: fields.instant("When someone ended the grant early.").nullable(),
      ended_by: fields.ref("person who ended it early").nullable(),
    },
    serverSet: ["partner_org_id", "valid_from", "record_grant_id", "ended_at", "ended_by"],
  }),
);

export const a79Resources: readonly ResourceSpec[] = [
  resource("Platform", "/ownership-transfers", OwnershipTransfer, {
    verbs: ["list", "get"],
    order: { by: ["offered_at"], numeric: false, descending: true },
    actions: [
      collectionAction("offer", {
        summary: "Offer ownership of the organization",
        description:
          "An Owner (org.ownership.transfer) with step-up offers the bound org to another active member who is not an Owner (app.offer_ownership_transfer), choosing whether they become an Admin or leave on acceptance. One open offer per org; it lapses after 7 days. Without a recent second factor the call answers 422 step_up_required; an API key answers step_up_session_only.",
        body: z
          .object({
            to_person_id: fields.ref("member to offer the org to"),
            previous_owner_outcome: z
              .enum(["admin", "leave"])
              .meta({
                description: "What happens to the offering Owner on acceptance.",
                example: "admin",
              }),
          })
          .meta({ id: "OwnershipTransferOfferRequest", description: "An ownership offer." }),
        rpc: "offer_ownership_transfer",
        status: 201,
      }),
      itemAction("accept", {
        summary: "Accept ownership",
        description:
          "The member the org was offered to accepts with step-up, so a second factor (app.accept_ownership_transfer): they become an Owner, then the old Owner becomes an Admin (or leaves) and loses the Owner role, so the org keeps an Owner at every step (invariant 4). An answered, withdrawn or lapsed offer answers 422.",
        rpc: "accept_ownership_transfer",
      }),
      itemAction("decline", {
        summary: "Decline ownership",
        description: "The member the org was offered to declines (app.decline_ownership_transfer).",
        rpc: "decline_ownership_transfer",
      }),
      itemAction("cancel", {
        summary: "Withdraw an ownership offer",
        description:
          "The Owner who offered, or any Owner, withdraws an open offer (app.cancel_ownership_transfer).",
        rpc: "cancel_ownership_transfer",
      }),
    ],
  }),
  resource("Platform", "/org-deletion-requests", OrgDeletionRequest, {
    verbs: ["list", "get"],
    order: { by: ["requested_at"], numeric: false, descending: true },
    actions: [
      collectionAction("request", {
        summary: "Ask to delete the organization",
        description:
          "The Owner (org.organization.delete) with step-up types the bound org's name and a reason (app.request_org_deletion). The subscription ends, the org is read-only at once, every Owner is told, and the data is deleted after 7 days unless an Owner recovers it. A partner with clients and an org under a legal hold are refused with 422.",
        body: z
          .object({
            confirm_name: fields.text(
              "The org's name, typed exactly.",
              "Harbor Lights Productions",
              200,
            ),
            reason: fields.longText("Why the org is deleted.", "We are closing down."),
          })
          .meta({ id: "OrgDeletionRequestCreate", description: "A deletion request." }),
        rpc: "request_org_deletion",
        status: 201,
      }),
      itemAction("recover", {
        summary: "Recover the organization",
        description:
          "An Owner recovers the org within the 7-day window (app.recover_org_deletion): writes work again and, unless the org is also canceled, it restarts on the Access plan.",
        rpc: "recover_org_deletion",
      }),
    ],
  }),
  resource("Platform", "/deletion-certificates", DeletionCertificate, {
    verbs: ["list", "get"],
    order: { by: ["due_at"], numeric: false, descending: true },
  }),
  resource("Platform", "/partner-standing-grants", PartnerStandingGrant, {
    verbs: ["list", "get"],
    order: { by: ["valid_from"], numeric: false, descending: true },
    actions: [
      collectionAction("record", {
        summary: "Record a standing partner grant",
        description:
          "The client Owner (org.support_session.grant) records a grant the partner and client agreement provides (app.record_standing_grant): one read capability a support session may grant, an expiry within a year and the clause. A scope outside those, an expiry past a year and an org without a partner answer 422.",
        body: z
          .object({
            capability_code: fields.code(
              "The read capability the grant covers.",
              "org.settings.read",
            ),
            valid_to: fields.instant("When the grant ends, within a year."),
            agreement_reference: fields.text(
              "The clause of the agreement.",
              "Partner agreement, clause 7.2",
            ),
          })
          .meta({
            id: "PartnerStandingGrantRecordRequest",
            description: "A standing grant to record.",
          }),
        rpc: "record_standing_grant",
        status: 201,
      }),
      itemAction("end", {
        summary: "End a standing partner grant",
        description:
          "Ends a standing grant early (app.end_standing_grant): the client's Owner or the partner's staff with org.partner.manage. An ended grant answers 422.",
        rpc: "end_standing_grant",
      }),
    ],
  }),
];

export const a79Capabilities: Readonly<Record<string, CapabilityRule>> = {
  ownershipTransfers: {
    read: "org.members.read",
    actions: {
      offer: "org.ownership.transfer",
      accept: "org.members.read",
      decline: "org.members.read",
      cancel: "org.ownership.transfer",
    },
  },
  orgDeletionRequests: {
    read: "org.settings.read",
    actions: { request: "org.organization.delete", recover: "org.organization.delete" },
  },
  deletionCertificates: { read: "org.settings.read" },
  partnerStandingGrants: {
    read: "org.settings.read",
    actions: { record: "org.support_session.grant", end: "org.support_session.grant" },
  },
};

// Identity: leaving a partner, checking a domain, and what creating an org starts with --------------------------------

export const a79IdentityActions: Readonly<Record<string, readonly ActionSpec[]>> = {
  organizations: [
    collectionAction("leavePartner", {
      segment: "leave-partner",
      summary: "Leave the partner",
      description:
        "The client Owner (org.billing.manage) types the bound org's name; the org leaves its partner and becomes a direct customer (app.leave_partner). Its rendered brand becomes its own, the partner's support sessions and standing grants end, and billing moves to the org as a 14-day trial of the same plan that stays once a card is added. Data and members are untouched. An org without a partner answers 422.",
      body: z
        .object({
          confirm_name: fields.text("The org's name, typed exactly.", "Tidewater Events", 200),
        })
        .meta({ id: "LeavePartnerRequest", description: "Confirmation of leaving the partner." }),
      rpc: "leave_partner",
    }),
  ],
  verifiedDomains: [
    itemAction("check", {
      summary: "Check a custom domain again",
      description:
        "Queues the provider worker for a custom Atlas, Gateway or sending domain (app.request_domain_check): provisioning again when it never reached the provider, otherwise checking DNS verification and TLS now. Verified domains answer 422 (domain_not_provisioned). Returns the domain.",
      rpc: "request_domain_check",
    }),
  ],
};

export const a79IdentityCapabilities: Readonly<Record<string, CapabilityRule>> = {
  organizations: { actions: { leavePartner: "org.billing.manage" } },
  verifiedDomains: { actions: { check: "org.white_label.write" } },
};

const dnsRecord = z
  .object({
    type: fields.text("DNS record type.", "CNAME", 10),
    name: fields.text("Host the record is published at.", "atlas.northwindlive.example", 253),
    value: fields.text("Record value.", "cname.vercel-dns.com", 2000),
    purpose: fields.text(
      "What the record is for: routing, verification, spf, dkim, dmarc or receiving.",
      "routing",
      20,
    ),
  })
  .meta({
    id: "DomainDnsRecord",
    description: "A DNS record the org publishes for a custom domain's provider.",
  });

export const a79IdentityCorrections: readonly CorrectionInput[] = [
  {
    id: "organization-create-trial",
    since: SINCE,
    resources: ["organizations"],
    change: "`organizations.create` starts a 14-day Pro trial instead of the Access plan.",
    reason:
      "app.create_organization (1350, Section 14.7) starts every new org on a 14-day Pro trial with no card; it moves to the Access plan at the end unless a card is added.",
    apply: (spec: ResourceSpec): ResourceSpec => ({
      ...spec,
      actions: spec.actions.map((a) =>
        a.verb === "create"
          ? {
              ...a,
              description:
                "Creates an organization with the caller as its Owner, in one transaction, through `app.create_organization`. It starts a 14-day Pro trial with no card and moves to the Access plan when the trial ends unless a card is added (Section 14.7). A reserved or taken slug is refused with 422.",
            }
          : a,
      ),
    }),
  },
  {
    id: "verified-domain-provisioning",
    since: SINCE,
    resources: ["verifiedDomains"],
    components: ["schemas/DomainDnsRecord"],
    change:
      "Adds the server-set `provisioning_status`, `dns_records`, `tls_ready` and `provisioning_error` of custom domains.",
    reason:
      "Custom Atlas, Gateway and sending domains are provisioned through Vercel and Resend (1355, Section 12); app.org_domains records where each stands, the DNS records to publish and TLS. Only the provider worker writes them.",
    apply: editShape({
      add: {
        provisioning_status: {
          schema: z
            .enum(["Not Started", "Requested", "Pending DNS", "Active", "Failed", "Released"])
            .meta({
              description: "Where the domain stands at its provider.",
              example: "Pending DNS",
            }),
        },
        dns_records: {
          schema: z
            .array(dnsRecord)
            .meta({ description: "DNS records to publish for the provider." }),
        },
        tls_ready: {
          schema: z
            .boolean()
            .meta({
              description: "True once the provider issued the TLS certificate.",
              example: false,
            }),
        },
        provisioning_error: {
          schema: orNull(
            fields.text("Why the latest provisioning step failed.", "Vercel returned 400", 2000),
          ),
        },
      },
      serverSet: ["provisioning_status", "dns_records", "tls_ready", "provisioning_error"],
    }),
  },
];

// Settings: the trial end on subscriptions -------------------------------------------------------------------------

export const a79SettingsCorrections: readonly CorrectionInput[] = [
  {
    id: "subscription-trial-ends-at",
    since: SINCE,
    resources: ["subscriptions"],
    change: "Adds the read-only `trial_ends_at`.",
    reason:
      "app.subscriptions.trial_ends_at (1350, Section 14.7) holds when a trialing subscription's 14-day trial ends, and stays as history after it converts or moves to the Access plan. Only the trial machinery sets it.",
    apply: editShape({
      add: {
        trial_ends_at: {
          schema: orNull(
            fields.instant("When the subscription's trial ends; null when it never had one."),
          ),
        },
      },
      serverSet: ["trial_ends_at"],
    }),
  },
];
