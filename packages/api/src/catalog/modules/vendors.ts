/**
 * Vendors operations beyond the frozen v1 catalog (additive only, Section 10.1), and the
 * corrections of frozen Vendors resources to the A03 and A16 schema (ADR 0023): migrations 0330
 * (vendors and their compliance) and 0492 (sponsor assets and deliveries).
 */
import { z } from "@hono/zod-openapi";
import { fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, putActions, removeActions } from "../correct.ts";
import { itemAction, transition } from "../define.ts";

const SINCE = "1.0.0-draft.2";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

const score = (what: string) => orNull(fields.int(`${what}, 1 to 5; null when not scored.`, 4, 1));

export const additions = defineAdditions("Vendors", {
  corrections: [
    {
      id: "vendor-counterparty-facet",
      since: SINCE,
      resources: ["vendors"],
      change:
        "A vendor is the facet of a required, fixed `counterparty_id`; `counterparty_type` is read from the counterparty; adds `payment_terms_days` and `default_currency_code`; removes `organization_id` and `internal_notes`. `vendor_state` is Prospect, Onboarded, Active, Blocked or Canceled, moved by the added `vendors.transition`.",
      reason:
        "app.vendors (0330) is one facet per counterparty (the company's identity lives on app.organizations, its type on app.counterparties), records terms and default currency, has no notes column, and changes state only through app.transition_vendor.",
      apply: all(
        editShape({
          remove: ["organization_id", "internal_notes"],
          serverSet: ["counterparty_type"],
          nullable: ["counterparty_type"],
          add: {
            counterparty_id: {
              schema: fields.ref("counterparty the vendor facet belongs to"),
              create: "required",
              update: false,
            },
            payment_terms_days: {
              schema: orNull(fields.int("Days after invoice the vendor is paid.", 30)),
              create: "optional",
            },
            default_currency_code: {
              schema: orNull(fields.currency("ISO 4217 currency the vendor bills in by default.")),
              create: "optional",
            },
            vendor_state: {
              schema: label(
                ["Prospect", "Onboarded", "Active", "Blocked", "Canceled"],
                "Vendor state.",
              ),
            },
          },
        }),
        putActions([transition("Vendor", ["Prospect", "Onboarded"])], {
          transition: "vendors.vendor.write",
        }),
      ),
    },
    {
      id: "vendor-class-standard-library",
      since: SINCE,
      resources: ["vendorClasses"],
      change: "Adds `std_vendor_class_id` and `description`; removes `counterparty_type`.",
      reason:
        "app.vendor_classes (0330) records the Standard Library class an org adopted and a description; it has no counterparty type column.",
      apply: editShape({
        remove: ["counterparty_type"],
        add: {
          std_vendor_class_id: {
            schema: orNull(fields.code("Standard Library vendor class adopted.", "VC-001")),
            create: "optional",
          },
          description: {
            schema: orNull(fields.longText("What the class covers.", "Staging rental houses.")),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "prequalification-decision",
      since: SINCE,
      resources: ["prequalifications"],
      change:
        "Adds the required `scope_note` and the server-set `decision`, `decided_by` and `decided_at`; removes `prequalification_state` and `prequalifications.transition`, replaced by `prequalifications.decide`.",
      reason:
        "app.prequalifications (0330) is pending while `decision` is NULL and decided once through app.decide_prequalification (Approved or Rejected, with an optional `valid_to`) by someone other than the requester; there is no state machine.",
      apply: all(
        editShape({
          remove: ["prequalification_state"],
          add: {
            scope_note: {
              schema: fields.longText(
                "What the vendor is prequalified for.",
                "Rigging over 2,000 kg.",
              ),
              create: "required",
            },
            decision: {
              schema: orNull(label(["Approved", "Rejected"], "Decision; null while pending.")),
            },
            decided_by: { schema: orNull(fields.ref("person who decided")) },
            decided_at: { schema: orNull(fields.instant("When it was decided.")) },
          },
        }),
        removeActions("transition"),
        putActions(
          [
            itemAction("decide", {
              summary: "Decide a prequalification",
              description:
                "Approves or rejects a pending prequalification through app.decide_prequalification: vendors.prequalification.approve, never by the requester, final once decided. A refusal returns 422 and names the rule.",
              body: z
                .object({
                  decision: label(["Approved", "Rejected"], "Decision."),
                  valid_to: z.iso
                    .date()
                    .optional()
                    .meta({ description: "Last day an approval holds.", example: "2027-12-31" }),
                })
                .meta({
                  id: "PrequalificationDecideRequest",
                  description: "Request to decide a prequalification.",
                }),
            }),
          ],
          { decide: "vendors.prequalification.approve" },
        ),
      ),
    },
    {
      id: "insurance-certificate-columns",
      since: SINCE,
      resources: ["insuranceCertificates"],
      change:
        "The insured is `vendor_id`; `each_occurrence_minor` becomes `coverage_limit_minor`, `currency` becomes the nullable `currency_code`, `expires_on` becomes `valid_to`; adds the required `insurer`, `policy_identifier` and `valid_from`, and `document_uri`; removes `organization_id` and `document_id`.",
      reason:
        "app.insurance_certificates (0330) belongs to a vendor, records carrier, policy and validity window (NOT NULL), stores the limit in minor units with its currency only when stated, and links the stored certificate by URI.",
      apply: editShape({
        remove: ["organization_id", "document_id"],
        rename: {
          each_occurrence_minor: "coverage_limit_minor",
          currency: "currency_code",
          expires_on: "valid_to",
        },
        nullable: ["currency_code"],
        add: {
          vendor_id: { schema: fields.ref("insured vendor"), create: "required" },
          insurer: {
            schema: fields.text("Insurance carrier.", "Example Mutual"),
            create: "required",
          },
          policy_identifier: {
            schema: fields.text("Policy number.", "GL-2027-0042", 100),
            create: "required",
          },
          valid_from: { schema: fields.date("First day of coverage."), create: "required" },
          document_uri: {
            schema: orNull(fields.url("Where the certificate document is stored.")),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "vendor-scorecard-dimensions",
      since: SINCE,
      resources: ["vendorScorecards"],
      change:
        "One score becomes `quality_score`, `delivery_score` and `safety_score` (each nullable, 1 to 5) for a required `period_end`; `notes` becomes `note`; removes `score`.",
      reason:
        "app.vendor_scorecards (0330) scores three dimensions per period, leaving an unscored dimension NULL (never zero), and names the comment column `note`.",
      apply: editShape({
        remove: ["score"],
        rename: { notes: "note" },
        add: {
          period_end: { schema: fields.date("Last day of the period scored."), create: "required" },
          quality_score: { schema: score("Quality"), create: "optional" },
          delivery_score: { schema: score("On-time delivery"), create: "optional" },
          safety_score: { schema: score("Safety"), create: "optional" },
        },
      }),
    },
    {
      id: "sponsor-entitlement-project-counterparty",
      since: SINCE,
      resources: ["sponsorEntitlements"],
      change:
        "An entitlement is a `description` owed on a required, fixed `project_id` to a required sponsor `counterparty_id`, with `due_on` and the server-set `fulfilled_at`; removes `engagement_id`, `name` and `fulfillment_state`. `sponsorEntitlements.transition` is replaced by `sponsorEntitlements.fulfill` and `sponsorEntitlements.reopen`.",
      reason:
        "app.sponsor_entitlements (0330) is keyed by project and sponsor counterparty (NOT NULL), names the entitlement `description`, and records delivery as `fulfilled_at` rather than a lifecycle; deliveries and proof of performance are app.entitlement_deliveries and app.sponsor_proof_of_performance (0492).",
      apply: all(
        editShape({
          remove: ["engagement_id", "fulfillment_state"],
          rename: { name: "description" },
          add: {
            project_id: {
              schema: fields.ref("project the entitlement is delivered on"),
              create: "required",
              update: false,
            },
            counterparty_id: { schema: fields.ref("sponsor counterparty"), create: "required" },
            description: {
              schema: fields.text("The entitlement.", "Logo on the main stage scrims.", 500),
              create: "required",
            },
            due_on: {
              schema: orNull(fields.date("When the entitlement is owed.")),
              create: "optional",
            },
            fulfilled_at: {
              schema: orNull(fields.instant("When it was delivered; null while owed.")),
            },
          },
        }),
        removeActions("transition"),
        putActions(
          [
            itemAction("fulfill", {
              summary: "Mark an entitlement fulfilled",
              description:
                "Stamps `fulfilled_at` now. Needs vendors.entitlement.write on the project.",
            }),
            itemAction("reopen", {
              summary: "Mark an entitlement owed again",
              description: "Clears `fulfilled_at`. Needs vendors.entitlement.write on the project.",
            }),
          ],
          { fulfill: "vendors.entitlement.write", reopen: "vendors.entitlement.write" },
        ),
      ),
    },
  ],
});
