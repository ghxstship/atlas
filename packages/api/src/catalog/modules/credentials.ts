/**
 * Credentials operations beyond the frozen v1 catalog (additive only, Section 10.1), and the
 * corrections ADR 0023 allows while v1 is a draft. See "Adding operations" and "Correcting the
 * frozen contract" in packages/api/README.md.
 *
 * A14 (RRR-26): credential categories, issued credentials, the access grid, scans, certifications
 * and certification holders, against migrations 0352, 0470 and 0985.
 */
import { z } from "@hono/zod-openapi";
import { fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, removeActions, setOrder } from "../correct.ts";
import { Constants } from "@xos/data/database.types";

const SINCE = "1.0.0-draft.2";

const scanResult = z
  .enum(Constants.app.Enums.scan_result)
  .meta({ description: "The database's decision for the scan.", example: "Granted" });

export const additions = defineAdditions("Credentials", {
  corrections: [
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
