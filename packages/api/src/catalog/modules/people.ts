/**
 * People operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on People resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen People resources follow ADR 0023.
 */
import { z } from "@hono/zod-openapi";
import { RateType, canonCodes, fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, putActions, removeActions, setCapabilities } from "../correct.ts";
import { itemAction, transition } from "../define.ts";
import { Constants } from "@xos/data/database.types";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

/**
 * People schema corrections (A13): role assignments, requisitions and agreements, from the People
 * schema of migration 0361. The offer corrections below are separate and belong to the offers
 * owners.
 */
const peopleCorrections = [
  {
    id: "role-assignment-staffing",
    since: "1.0.0-draft.2",
    resources: ["roleAssignments"],
    change:
      "An assignment is one person (`person_id`, required) in a canon role, with `requisition_id`, `staffing_basis` (Ratio, Fixed or Declared), `starts_on`, `ends_on` and `assignment_state` (Proposed, Active, Complete or Canceled); removes `headcount` and `ratio_basis`.",
    reason:
      "app.role_assignments (0361) is one row per assigned person (`person_id` NOT NULL); the headcount a role needs comes from the canon staffing ratio, and the row records only which basis sized it (`staffing_basis`, default Declared) and the assignment dates and state.",
    apply: editShape({
      remove: ["headcount", "ratio_basis"],
      add: {
        person_id: { schema: fields.ref("assigned person"), create: "required" },
        requisition_id: {
          schema: orNull(fields.ref("requisition the assignment fills")),
          create: "optional",
        },
        staffing_basis: {
          schema: label(
            Constants.app.Enums.staffing_basis,
            "How the role was sized: from the canon staffing ratio, a fixed canon count per tier, or declared.",
          ),
          create: "optional",
        },
        starts_on: {
          schema: orNull(fields.date("First day of the assignment.")),
          create: "optional",
        },
        ends_on: { schema: orNull(fields.date("Last day of the assignment.")), create: "optional" },
        assignment_state: {
          schema: label(Constants.app.Enums.role_assignment_state, "Assignment state."),
        },
      },
    }),
  },
  {
    id: "requisition-canon-rate-combination",
    since: "1.0.0-draft.2",
    resources: ["requisitions"],
    change:
      "A requisition asks for a `headcount` of a required canon `role_code`, priced by the canon combination `worker_classification`, `pay_basis` and `arrangement` with `units_per_head` and `rate_minor` in a required `currency_code`, with a required `justification`; adds `scope_node_id`, `budget_line_id`, `role_type`, `starts_on`, `ends_on` and `requested_by`. Removes `title`, `urid`, `positions`, `budget_minor` and `currency`. `requisition_state` is Proposed, Approved, Rejected, Filled or Canceled and the transition example becomes Approved to Filled.",
    reason:
      "app.requisitions (0361) stores the role (NOT NULL), headcount (default 1), the xpms.rate_card combination with units per head and a nullable rate (the estimate is headcount times units times rate, unpriced when any is NULL), a NOT NULL currency and justification, and the requester from the session; it has no title, catalog URID or budget amount column.",
    apply: all(
      editShape({
        remove: ["title", "urid", "positions", "budget_minor", "currency"],
        add: {
          role_code: { schema: canonCodes.RoleCode, create: "required" },
          scope_node_id: {
            schema: orNull(fields.ref("scope node of the same project")),
            create: "optional",
          },
          budget_line_id: {
            schema: orNull(fields.ref("budget line the cost is charged to")),
            create: "optional",
          },
          role_type: {
            schema: orNull(
              label(
                Constants.app.Enums.external_role_type,
                "External role type an opportunity published from the requisition seeks; null when filled internally.",
              ),
            ),
            create: "optional",
          },
          worker_classification: {
            schema: orNull(
              fields.code("Worker classification, from xpms.worker_classification.", "EMPLOYEE"),
            ),
            create: "optional",
          },
          pay_basis: {
            schema: orNull(fields.text("Pay basis; set with the arrangement.", "Hourly")),
            create: "optional",
          },
          arrangement: {
            schema: orNull(fields.text("Arrangement; set with the pay basis.", "Per Engagement")),
            create: "optional",
          },
          headcount: { schema: fields.int("People requested.", 12, 1), create: "optional" },
          units_per_head: {
            schema: orNull(
              fields.quantity("Pay basis units each person works, such as hours.", 10),
            ),
            create: "optional",
          },
          rate_minor: {
            schema: fields.money("Rate per pay basis unit.", 4500),
            create: "optional",
          },
          currency_code: {
            schema: fields.currency("ISO 4217 currency of the rate."),
            create: "required",
          },
          starts_on: { schema: orNull(fields.date("First day of the work.")), create: "optional" },
          ends_on: { schema: orNull(fields.date("Last day of the work.")), create: "optional" },
          justification: {
            schema: fields.text(
              "Why the staff are needed.",
              "Second stage added for the festival.",
              2000,
            ),
            create: "required",
          },
          requested_by: {
            schema: orNull(fields.ref("person who requested; they cannot approve it")),
          },
          requisition_state: {
            schema: label(Constants.app.Enums.requisition_state, "Requisition state."),
          },
        },
      }),
      putActions([transition("Requisition", ["Approved", "Filled"])]),
    ),
  },
  {
    id: "agreement-text-and-signer",
    since: "1.0.0-draft.2",
    resources: ["agreements"],
    change:
      "An agreement carries its `agreement_kind` and full `body` (both required) for a `person_id` or `counterparty_id`, with optional `project_id` and `offer_id`, and records `token_expires_at`, `signed_name` and `signed_body_sha256`; removes `engagement_id` and `document_id`. `agreement_state` is Proposed, Sent, Signed, Superseded, Expired or Canceled.",
    reason:
      "app.agreements (0361, 0981) stores the text the signer reads in `body` with its kind (both NOT NULL), names the party by person or counterparty, links an optional offer, and on signing keeps the typed name and the SHA-256 of the signed text. It has no engagement or document column; token and access code hashes are never returned.",
    apply: editShape({
      remove: ["engagement_id", "document_id"],
      add: {
        agreement_kind: {
          schema: label(Constants.app.Enums.agreement_kind, "Kind of agreement."),
          create: "required",
        },
        body: {
          schema: fields.longText(
            "Full text the signer reads and signs; changes only while Proposed.",
            "The crew member agrees to the call times in the schedule.",
          ),
          create: "required",
        },
        project_id: {
          schema: orNull(fields.ref("project the agreement covers")),
          create: "optional",
        },
        offer_id: { schema: orNull(fields.ref("offer the agreement follows")), create: "optional" },
        person_id: {
          schema: orNull(fields.ref("person party to the agreement")),
          create: "optional",
        },
        counterparty_id: {
          schema: orNull(fields.ref("external organization party to the agreement")),
          create: "optional",
        },
        token_expires_at: {
          schema: orNull(fields.instant("When the signing link stops working.")),
        },
        signed_name: {
          schema: orNull(fields.text("Name the signer typed as their signature.", "Alex Rivera")),
        },
        signed_body_sha256: {
          schema: orNull(
            z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .meta({
                description: "SHA-256 of the text that was signed, lowercase hex.",
                example: "9f2c4e1a7b3d5f6e8a0c2e4f6a8b0d2c4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b",
              }),
          ),
        },
        agreement_state: {
          schema: label(Constants.app.Enums.agreement_state, "Agreement state."),
        },
      },
    }),
  },
  {
    id: "agreement-sign-typed-name",
    since: "1.0.0-draft.2",
    resources: ["agreements"],
    change:
      "`agreements.sign` takes the signer's typed `signed_name` and the `body_sha256` of the text they read; a Sent agreement that names the caller is signed, and a changed text or an agreement that is not Sent is refused (422).",
    reason:
      "app.sign_agreement (0361) signs as the signed-in person the agreement names and needs the typed name and the SHA-256 of the text they read, which it compares with the stored body; the frozen action had no body to carry them.",
    apply: putActions([
      itemAction("sign", {
        summary: "Sign an agreement",
        description:
          "The person the agreement names signs it with their typed name and the SHA-256 of the text they read. A signed agreement cannot be revoked or unsigned; a second signature, a changed text or an agreement that is not Sent is refused (422).",
        rpc: "sign_agreement",
        body: z
          .object({
            signed_name: fields.text(
              "Name the signer types as their signature.",
              "Alex Rivera",
              200,
            ),
            body_sha256: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .meta({
                description: "SHA-256 of the agreement text the signer read, lowercase hex.",
                example: "9f2c4e1a7b3d5f6e8a0c2e4f6a8b0d2c4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b",
              }),
          })
          .meta({ id: "AgreementSignRequest", description: "The signature on an agreement." }),
      }),
    ]),
  },
] as const;

/** The terms of one offer version, as app.send_offer, revise_offer and counter_offer take them. */
const terms = {
  rate_type: orNull(RateType),
  amount_minor: fields.money(
    "Offered amount per rate unit; null when the version leaves the amount open.",
    45000,
  ),
  currency_code: orNull(fields.currency("ISO 4217 currency of the amount.")),
  starts_on: orNull(fields.date("First day of the work offered.")),
  ends_on: orNull(fields.date("Last day of the work offered.")),
  message: orNull(
    fields.text(
      "Message to the other side with the terms. Visible to both sides.",
      "Rate includes the load-in day.",
      4000,
    ),
  ),
};

const reasonBody = (id: string, description: string, example: string) =>
  z
    .object({
      reason: fields.text("Why, recorded on the offer's state transition.", example, 2000),
    })
    .meta({ id, description });

export const additions = defineAdditions("People", {
  corrections: [
    ...peopleCorrections,
    // Offers --------------------------------------------------------------------------------------
    {
      id: "offer-versioned-terms",
      since: "1.0.0-draft.2",
      resources: ["offers"],
      change:
        "An offer carries the terms in force from its latest version: `version_number`, `proposed_side`, `rate_type`, `amount_minor`, `currency_code`, `starts_on`, `ends_on`, `message` and `expires_at`; `rate_minor` and `currency` are removed and the amount is no longer masked. Create sends the offer with its first terms (`offers.send` is removed), update revises the terms, `counter` takes the terms without an expiry, `decline` takes a reason, and `offers.withdraw` is added. `application_id` is required.",
      reason:
        "app.offers (0764) holds only the application and the state; the terms live in the append-only app.offer_versions, visible to both sides. app.send_offer creates and sends in one call, app.revise_offer adds an org version, app.counter_offer a party version, and app.decline_offer and app.withdraw_offer take a reason.",
      apply: all(
        editShape({
          remove: ["rate_minor", "currency"],
          serverSet: ["person_id", "organization_id"],
          add: {
            application_id: {
              schema: fields.ref("application the offer answers"),
              create: "required",
              update: false,
            },
            version_number: {
              schema: fields.int(
                "Version of the terms in force, issued by the database; the highest is in force.",
                1,
              ),
            },
            proposed_side: {
              schema: z.enum(Constants.app.Enums.offer_side).meta({
                description: "Side that proposed the terms in force.",
                example: "Organization",
              }),
            },
            rate_type: { schema: terms.rate_type, create: "optional" },
            amount_minor: { schema: terms.amount_minor, create: "optional" },
            currency_code: { schema: terms.currency_code, create: "optional" },
            starts_on: { schema: terms.starts_on, create: "optional" },
            ends_on: { schema: terms.ends_on, create: "optional" },
            message: { schema: terms.message, create: "optional" },
            expires_at: {
              schema: orNull(fields.instant("When the terms in force lapse unanswered.")),
              create: "optional",
            },
          },
        }),
        removeActions("send"),
        putActions(
          [
            itemAction("counter", {
              summary: "Counter an offer",
              description:
                "The applicant side counters the terms in force with its own, as a new version; the offer becomes Countered.",
              body: z
                .object(terms)
                .partial()
                .meta({ id: "OfferCounterRequest", description: "Counter terms for an offer." }),
            }),
            itemAction("decline", {
              summary: "Decline an offer",
              description:
                "The applicant side declines the organization's terms; the offer and the application become Declined.",
              body: reasonBody(
                "OfferDeclineRequest",
                "Request to decline an offer.",
                "The dates conflict with another booking.",
              ),
            }),
            itemAction("withdraw", {
              summary: "Withdraw an offer",
              description:
                "The organization withdraws an offer that is Sent or Countered; the application becomes Not Selected.",
              body: reasonBody(
                "OfferWithdrawRequest",
                "Request to withdraw an offer.",
                "The position was filled internally.",
              ),
            }),
          ],
          { withdraw: "opportunities.offer.send" },
        ),
        setCapabilities({ create: "opportunities.offer.send", write: "opportunities.offer.send" }),
      ),
    },
  ],
});
