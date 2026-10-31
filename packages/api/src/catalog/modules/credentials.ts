/**
 * Credentials operations beyond the frozen v1 catalog (additive only, Section 10.1), and the
 * corrections ADR 0023 allows while v1 is a draft. See "Adding operations" and "Correcting the
 * frozen contract" in packages/api/README.md.
 *
 * A14 (RRR-26): credential categories, issued credentials, the access grid, scans, certifications
 * and certification holders, against migrations 0352, 0470 and 0985. B8 (RRR-232, 2970 and 2972): a scan's
 * direction, the database's refusal reason and the supervisor override, and the training a category requires.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, removeActions, setOrder } from "../correct.ts";
import { itemAction, resource } from "../define.ts";

const SINCE = "1.0.0-draft.2";

const scanResult = z
  .enum(["Granted", "Denied"])
  .meta({ description: "The database's decision for the scan.", example: "Granted" });

const scanDirection = z
  .enum(["In", "Out"])
  .meta({ description: "In at the zone, or Out. An Out scan is never refused.", example: "In" });

const refusalReason = z
  .enum(["Revoked", "Not Yet Valid", "Expired", "No Zone Access", "Outside Window"])
  .meta({
    description:
      "Why the database denied an In scan, the first check that failed; null for a granted scan and for denials recorded before B8.",
    example: "Outside Window",
  });

/** app.credential_category_requirements (2972, B8): what a category requires before it is issued. */
const CredentialCategoryRequirement = defineResource({
  name: "CredentialCategoryRequirement",
  table: "app.credential_category_requirements",
  description:
    "A training course or a certification a credential category requires before it is issued (gap G-148): issuing the category to someone who does not meet it now is refused (credential_training_incomplete, 422).",
  immutable: ["credential_category_id", "training_course_id", "certification_id"],
  serverSet: ["created_by", "updated_by"],
  fields: {
    credential_category_id: fields.ref("credential category"),
    training_course_id: orNull(fields.ref("training course the holder must have passed")),
    certification_id: orNull(fields.ref("certification the holder must hold")),
    created_by: orNull(fields.uuid("Person who added the requirement.")),
    updated_by: orNull(fields.uuid("Person who last changed the requirement.")),
  },
});

const overrideBody = z
  .object({
    reason: z.string().min(1).max(300).meta({
      description: "Why the supervisor lets the holder in, 1 to 300 characters.",
      example: "Badge reprint pending; confirmed with the production office.",
    }),
    id: fields.uuid("Client id of the override scan, for an offline replay.").optional(),
  })
  .meta({
    id: "AccessScanOverrideRequest",
    description: "A supervisor override of a denied scan.",
  });

export const additions = defineAdditions("Credentials", {
  resources: [
    resource("Credentials", "/credential-category-requirements", CredentialCategoryRequirement, {
      verbs: ["list", "get", "create", "delete"],
    }),
  ],
  actions: {
    accessScans: [
      itemAction("override", {
        summary: "Override a denied scan",
        description:
          "Lets the holder of a Denied In scan less than 15 minutes old in: records a new Granted In row tied to it, with the reason. Needs credentials.credential.issue on the project. Refuses scan_not_denied, scan_override_revoked (a revoked badge is never let in), scan_override_stale, scan_override_taken, scan_override_self (the holder) and scan_override_reason (422).",
        body: overrideBody,
        status: 201,
        rpc: "app.override_access_scan",
      }),
    ],
  },
  capabilities: {
    credentialCategoryRequirements: {
      read: "credentials.credential.read",
      write: "credentials.category.write",
    },
    accessScans: { actions: { override: "credentials.credential.issue" } },
  },
  corrections: [
    {
      id: "credential-category-kind",
      since: SINCE,
      resources: ["credentialCategories"],
      change: "Adds the optional `category_kind`, Access or Parking (Access by default).",
      reason:
        "app.credential_categories.category_kind (2691, R7) makes a parking pass a credential category of kind Parking, tied to parking zones through the access grid; allocations read the kind (Credential or Parking Pass).",
      apply: editShape({
        add: {
          category_kind: {
            schema: z.enum(["Access", "Parking"]).meta({
              description: "Access badge or parking pass.",
              example: "Parking",
            }),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "credential-category-project-and-code",
      since: SINCE,
      resources: ["credentialCategories"],
      change:
        "Adds a required `project_id` (immutable) and `code`; removes `color_token` and `position`; the default order is `code`.",
      reason:
        "app.credential_categories (0352) belongs to one project (NOT NULL) and is keyed by a code unique per project; it stores no badge color or display position, and Section 3.6 lists coded rows in code order.",
      apply: all(
        editShape({
          remove: ["color_token", "position"],
          add: {
            project_id: { schema: fields.ref("project"), create: "required" },
            code: {
              schema: fields.code("Category code, unique per project.", "ALL-ACCESS"),
              create: "required",
            },
          },
          immutable: ["project_id"],
        }),
        setOrder({ by: ["code"], numeric: false }),
      ),
    },
    {
      id: "credential-holder-number-and-revocation",
      since: SINCE,
      resources: ["credentials"],
      change:
        "The holder is `holder_person_id`; adds `credential_number`, `revoked_at` and `revoked_by` (set by the database); removes `person_id`, `credential_state` and `issued_at`; `project_id` is copied from the category; `issued_by` and `valid_to` become nullable and `valid_from` optional on create.",
      reason:
        "app.credentials (0352, 0470) names the holder in holder_person_id, numbers each credential from the org sequence, stamps revocation in revoked_at and revoked_by, and keeps no state column: a credential is active, scheduled, expired or revoked by its window and revocation. project_id is copied from the category by private.copy_parent_project (0470). issued_by is NULL for seed rows; valid_to NULL means valid until revoked; valid_from defaults to now.",
      apply: editShape({
        remove: ["person_id", "credential_state", "issued_at"],
        nullable: ["issued_by", "valid_to"],
        add: {
          holder_person_id: { schema: fields.ref("holder"), create: "required" },
          credential_number: {
            schema: fields.code(
              "Number printed on the badge, issued by the database.",
              "CR-000123",
            ),
          },
          revoked_at: { schema: orNull(fields.instant("When the credential was revoked.")) },
          revoked_by: { schema: orNull(fields.ref("person who revoked it")) },
        },
        serverSet: ["project_id"],
        optionalOnCreate: ["valid_from"],
      }),
    },
    {
      id: "access-grid-level-and-window",
      since: SINCE,
      resources: ["accessGridEntries"],
      change:
        "Replaces `allowed` with a required canon `access_level_enum_id`; the window `window_starts_at` and `window_ends_at` is required; adds `project_id`, copied from the category.",
      reason:
        "app.access_grid (0352, 0470) states access as a row of the canon Access Level enumeration during a NOT NULL time window (a missing row means no access, so there is no allowed flag), and copies the category's project for Compass sync.",
      apply: editShape({
        remove: ["allowed", "window_starts_at", "window_ends_at"],
        add: {
          access_level_enum_id: {
            schema: fields.code(
              "Access level: a row of the canon Access Level enumeration.",
              "ENM-036",
            ),
            create: "required",
            update: true,
          },
          window_starts_at: {
            schema: fields.instant("When access opens."),
            create: "required",
            update: true,
          },
          window_ends_at: {
            schema: fields.instant("When access closes."),
            create: "required",
            update: true,
          },
          project_id: { schema: fields.ref("project of the category, copied from it") },
        },
      }),
    },
    {
      id: "access-scan-database-decision",
      since: SINCE,
      resources: ["accessScans"],
      change:
        "Replaces `granted` and `refusal_reason` with `result` (Granted or Denied), decided by the database; `scanned_at` is the server time; adds `project_id` and the offline fields `device_scanned_at` and `offline_result`.",
      reason:
        "app.access_scans (0352, 0470) is decided by private.decide_access_scan at the database time from the credential and the access grid, never by the scanner, and stores the outcome in the scan_result enum. A device that scanned offline sends its own time and decision, which are kept beside the server's (0470).",
      apply: editShape({
        remove: ["granted", "refusal_reason"],
        add: {
          result: { schema: scanResult },
          project_id: { schema: fields.ref("project of the credential, copied from it") },
          device_scanned_at: {
            schema: orNull(fields.instant("When the device scanned, for a scan made offline.")),
            create: "optional",
          },
          offline_result: {
            schema: orNull(scanResult.meta({ description: "What the device decided offline." })),
            create: "optional",
          },
        },
        serverSet: ["scanned_at"],
      }),
    },
    {
      id: "access-scan-direction-and-override",
      since: SINCE,
      resources: ["accessScans"],
      change:
        "Adds `direction` (In or Out, optional on create, In by default), the database's `refusal_reason`, and `override_of_scan_id` and `override_reason`, which the `override` action sets.",
      reason:
        "app.access_scans gains direction and refusal_reason, set by private.decide_access_scan, and override columns written only by app.override_access_scan (2970, B8): an override is a new Granted In row tied to the denied scan, so the log stays append-only. Adding them back is additive.",
      apply: editShape({
        add: {
          direction: { schema: scanDirection, create: "optional" },
          refusal_reason: { schema: orNull(refusalReason) },
          override_of_scan_id: {
            schema: orNull(fields.ref("denied In scan this row overrides")),
          },
          override_reason: {
            schema: orNull(
              fields.text("Why the supervisor let the holder in.", "Reprint pending", 300),
            ),
          },
        },
      }),
    },
    {
      id: "certification-issuing-body",
      since: SINCE,
      resources: ["certifications"],
      components: ["schemas/TagId"],
      change:
        "Replaces `issuer` with a required `issuing_body`; removes `tag_id` and `validity_months`.",
      reason:
        "app.certifications (0352) stores the issuing body (NOT NULL) and no canon tag or validity period; a holder's expiry is stored on the holder row.",
      apply: editShape({
        remove: ["tag_id", "issuer", "validity_months"],
        add: {
          issuing_body: {
            schema: fields.text("Body that issues the certification.", "OSHA"),
            create: "required",
            update: true,
          },
        },
      }),
    },
    {
      id: "certification-holder-issue-and-consent",
      since: SINCE,
      resources: ["certificationHolders"],
      change:
        "Adds a required `issued_on`; `public_verification_consent` becomes `public_verification_consented`, changed only by the holder; removes `evidence_document_id` and `verified_at`; removes the `verify` action, since the person recording a holder is its verifier.",
      reason:
        "app.certification_holders (0352) stores the issue date (NOT NULL), sets verified_by from the session on insert and never changes it (private.guard_certification_holder), so there is no later verification step; evidence lives in attachments (A18 0590), and only the holder may consent to public verification.",
      apply: all(
        editShape({
          remove: ["evidence_document_id", "verified_at", "public_verification_consent"],
          add: {
            issued_on: {
              schema: fields.date("When the certification was issued."),
              create: "required",
            },
            public_verification_consented: {
              schema: fields.bool("Whether the holder allows public verification by code.", false),
              update: true,
            },
          },
        }),
        removeActions("verify"),
      ),
    },
  ],
});
