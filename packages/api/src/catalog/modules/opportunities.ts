/**
 * Opportunities operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Opportunities resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Opportunities resources follow ADR 0023.
 */
import { z } from "@hono/zod-openapi";
import { canonCodes, fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, removeActions } from "../correct.ts";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

export const additions = defineAdditions("Opportunities", {
  corrections: [
    {
      id: "opportunity-schema-shape",
      since: "1.0.0-draft.2",
      resources: ["opportunities"],
      change:
        "Dates become `starts_on` and `ends_on`, the pay range `pay_min_minor` and `pay_max_minor` with `currency_code`, the deadline `deadline_at`, and `urid` becomes `cat_urid`; adds `jurisdiction_id` and `minimum_age`. Removes `positions` (positions are rows of opportunityPositions) and `published_at`. `requisition_id`, `role_code`, `description` and `rate_type` become nullable, and `requisition_id` is accepted on update.",
      reason:
        "app.opportunities (0720) stores dates as dates, the posted pay range as `pay_min_minor`/`pay_max_minor` with a nullable `currency_code`, the deadline as `deadline_at`, the category as `cat_urid`, positions as app.opportunity_positions rows, and no publish time; `requisition_id`, `role_code`, `description` and `rate_type` (NULL is Rate on Request) are nullable.",
      apply: editShape({
        nullable: ["role_code", "description", "rate_type"],
        rename: { urid: "cat_urid" },
        remove: [
          "starts_at",
          "ends_at",
          "positions",
          "rate_min_minor",
          "rate_max_minor",
          "currency",
          "application_deadline_at",
          "published_at",
        ],
        optionalOnCreate: ["visibility"],
        add: {
          requisition_id: {
            schema: orNull(
              fields.ref(
                "approved requisition the opportunity is published from; required to publish Contractor, Crew and Staff opportunities and fixed once published",
              ),
            ),
            create: "optional",
          },
          jurisdiction_id: {
            schema: orNull(canonCodes.JurisdictionId),
            create: "optional",
          },
          starts_on: { schema: orNull(fields.date("First day of the work.")), create: "optional" },
          ends_on: { schema: orNull(fields.date("Last day of the work.")), create: "optional" },
          pay_min_minor: {
            schema: fields.money("Lower end of the posted pay range; null when not posted.", 3500),
            create: "optional",
          },
          pay_max_minor: {
            schema: fields.money("Upper end of the posted pay range; null when not posted.", 4500),
            create: "optional",
          },
          currency_code: {
            schema: orNull(fields.currency("ISO 4217 currency of the posted pay.")),
            create: "optional",
          },
          deadline_at: {
            schema: orNull(
              fields.instant(
                "Deadline for applications and bids. Bids stay sealed until it passes.",
              ),
            ),
            create: "optional",
          },
          minimum_age: {
            schema: orNull(
              fields.int("Minimum age for the work, 16 or older (Section 14.9).", 18, 16),
            ),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "opportunity-positions-are-rows",
      since: "1.0.0-draft.2",
      resources: ["opportunityPositions"],
      change:
        "A position is one row with `label`, `call_at` and `ends_at`; removes `title`, `role_code` and `count`.",
      reason:
        "app.opportunity_positions (0720) stores one row per position to fill (label and call window), not a count of seats per role; the role lives on the opportunity.",
      apply: editShape({
        remove: ["title", "role_code", "count"],
        add: {
          label: {
            schema: fields.text("Position label, for example Rigger 2.", "Rigger 2"),
            create: "required",
          },
          call_at: { schema: orNull(fields.instant("Call time.")), create: "optional" },
          ends_at: {
            schema: orNull(fields.instant("When the position's work ends.")),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "opportunity-requirements-by-kind",
      since: "1.0.0-draft.2",
      resources: ["opportunityRequirements"],
      change:
        "A requirement has a `requirement_kind` and a `description`; the insurance currency is `currency_code`. Removes `tag_id` and `statement`.",
      reason:
        "app.opportunity_requirements (0720) keys requirements by kind (Certification, Insurance, Equipment) with a NOT NULL description and a nullable currency for the insurance minimum; it has no tag column.",
      apply: editShape({
        remove: ["tag_id", "statement", "currency"],
        add: {
          requirement_kind: {
            schema: label(["Certification", "Insurance", "Equipment"], "Kind of requirement."),
            create: "required",
          },
          description: {
            schema: fields.longText("What is required.", "Rigging certification, current."),
            create: "required",
          },
          currency_code: {
            schema: orNull(fields.currency("ISO 4217 currency of the insurance minimum.")),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "application-applicant-columns",
      since: "1.0.0-draft.2",
      resources: ["applications"],
      change:
        "The applicant is `applicant_person_id` or `applicant_organization_id`; adds `submitted_by`, `cover_note`, `proposed_fee_minor` and `currency_code`. Removes `proposed_rate_minor`, `currency` and `submitted_at` (the row's `created_at` is the submission time). `profile_share_id` becomes nullable and `availability_confirmed` optional on create.",
      reason:
        "app.applications (0720) names the applicant columns `applicant_person_id` and `applicant_organization_id`, stores a proposed fee with a nullable currency, stamps `submitted_by` from the session, defaults `availability_confirmed` to false and lets `profile_share_id` be NULL.",
      apply: editShape({
        nullable: ["profile_share_id"],
        optionalOnCreate: ["availability_confirmed"],
        remove: ["person_id", "organization_id", "proposed_rate_minor", "currency", "submitted_at"],
        add: {
          applicant_person_id: {
            schema: orNull(fields.ref("applying person")),
            create: "optional",
            update: false,
          },
          applicant_organization_id: {
            schema: orNull(fields.ref("applying external account")),
            create: "optional",
            update: false,
          },
          submitted_by: {
            schema: orNull(
              fields.ref(
                "person who submitted, set from the session: the applicant, their representative or an account administrator",
              ),
            ),
          },
          cover_note: {
            schema: orNull(
              fields.longText("Note from the applicant.", "Available for both show days."),
            ),
            create: "optional",
          },
          proposed_fee_minor: {
            schema: fields.money(
              "Fee the applicant proposes instead of the posted one (artists).",
              250000,
            ),
            create: "optional",
          },
          currency_code: {
            schema: orNull(fields.currency("ISO 4217 currency of the proposed fee.")),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "bid-currency-and-validity",
      since: "1.0.0-draft.2",
      resources: ["bids"],
      change:
        "Adds `currency_code` (required on create), `valid_until` and the server-set `submitted_at`; removes `notes`. Removes `bids.unseal`: a bid unseals for a reader, it is never unsealed as an action.",
      reason:
        "app.bids (0720) has a NOT NULL `currency_code` for every line, `valid_until` and `submitted_at`, and no notes; sealing is a read rule (private.bid_readable_by_org: after the deadline, or earlier with procurement.bid.unseal), with no unseal state or RPC.",
      apply: all(
        editShape({
          remove: ["notes"],
          add: {
            currency_code: {
              schema: fields.currency("ISO 4217 currency of every line."),
              create: "required",
              update: false,
            },
            valid_until: {
              schema: orNull(fields.date("Last day the bid holds.")),
              create: "optional",
            },
            submitted_at: {
              schema: fields.instant("When the bid was submitted, set by the database."),
            },
          },
        }),
        removeActions("unseal"),
      ),
    },
    {
      id: "interview-kind-and-duration",
      since: "1.0.0-draft.2",
      resources: ["interviews"],
      change:
        "Adds `interview_kind` and `duration_minutes` (required on create), `location_text` and `internal_note`; removes `meeting_url` and `outcome_notes`.",
      reason:
        "app.interviews (0720) has NOT NULL `interview_kind` (Interview or Audition) and `duration_minutes` without defaults, stores the place or meeting link as `location_text` and keeps an internal note; it has no meeting URL or outcome notes column.",
      apply: editShape({
        remove: ["meeting_url", "outcome_notes"],
        add: {
          interview_kind: {
            schema: label(["Interview", "Audition"], "Interview or Audition."),
            create: "required",
          },
          duration_minutes: {
            schema: fields.int("Length in minutes.", 30, 1),
            create: "required",
          },
          location_text: {
            schema: orNull(
              fields.text("Place or meeting link.", "Production office, Hall B", 2000),
            ),
            create: "optional",
          },
          internal_note: {
            schema: orNull(
              fields.longText("Internal note. Never visible externally.", "Strong rigging resume."),
            ),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "engagement-document-kind",
      since: "1.0.0-draft.2",
      resources: ["engagementDocuments"],
      change:
        "Adds `document_kind` (required on create) and `expires_on`; `document_id` becomes nullable and optional on create.",
      reason:
        "app.engagement_documents (0700) has a NOT NULL `document_kind` without a default and a nullable `document_id`: the document is attached after the row exists, for example when the party uploads it.",
      apply: editShape({
        nullable: ["document_id"],
        add: {
          document_kind: {
            schema: label(
              [
                "Offer",
                "Agreement",
                "Statement of Work",
                "Non-Disclosure Agreement",
                "Rider",
                "Advance Packet",
                "Insurance Certificate",
                "Lien Waiver",
                "Settlement",
                "Proof of Performance",
                "Content Consent",
              ],
              "Kind of document.",
            ),
            create: "required",
            update: false,
          },
          expires_on: {
            schema: orNull(
              fields.date("Last day the document is valid, for documents that expire."),
            ),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "onboarding-requirement-columns",
      since: "1.0.0-draft.2",
      resources: ["onboardingRequirements"],
      change:
        "A requirement has `name`, `item_kind`, `is_blocking`, `valid_for_days` and `remind_days_before`; removes `item_type`, `title`, `blocking` and `validity_months`. `role_type` becomes nullable.",
      reason:
        "app.onboarding_requirements (0730) stores validity in days (`valid_for_days`), names the kind `item_kind` and the flag `is_blocking`, and leaves `role_type` NULL for requirements that apply to every role.",
      apply: editShape({
        nullable: ["role_type"],
        remove: ["item_type", "title", "blocking", "validity_months"],
        add: {
          name: {
            schema: fields.text(
              "Requirement name, for example Certificate of Insurance.",
              "Certificate of Insurance",
            ),
            create: "required",
          },
          item_kind: {
            schema: label(
              [
                "Document Upload",
                "Electronic Signature",
                "Form",
                "Certification",
                "Training",
                "Acknowledgment",
                "Background Check",
                "Tax Form",
                "Payout Details",
              ],
              "Kind of onboarding item.",
            ),
            create: "required",
          },
          is_blocking: {
            schema: fields.bool(
              "True when the engagement cannot become Active until the item passes.",
              true,
            ),
            create: "optional",
          },
          valid_for_days: {
            schema: orNull(
              fields.int("Days a verification stays valid; null when it does not expire.", 365, 1),
            ),
            create: "optional",
          },
          remind_days_before: {
            schema: orNull(fields.int("Days before expiry the party is reminded.", 30, 1)),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "onboarding-verification-reviewer-nullable",
      since: "1.0.0-draft.2",
      resources: ["onboardingVerifications"],
      change: "`verified_by` becomes nullable.",
      reason:
        "app.onboarding_verifications (0730) leaves `verified_by` NULL for verifications a provider or the platform records, such as background check results.",
      apply: editShape({ nullable: ["verified_by"] }),
    },
    {
      id: "talent-pool-kind",
      since: "1.0.0-draft.2",
      resources: ["talentPools"],
      change: "Replaces `role_type` with `pool_kind` (Talent or Vendor), required on create.",
      reason:
        "app.talent_pools (0720) keys a pool by `pool_kind`: Talent pools hold people and Vendor pools hold external accounts; it has no role type column.",
      apply: editShape({
        remove: ["role_type"],
        add: {
          pool_kind: {
            schema: label(["Talent", "Vendor"], "Talent (people) or Vendor (external accounts)."),
            create: "required",
            update: false,
          },
        },
      }),
    },
  ],
});
