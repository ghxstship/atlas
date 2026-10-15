/**
 * People operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on People resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen People resources follow ADR 0023.
 */
import { z } from "@hono/zod-openapi";
import { RateType, fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, putActions, removeActions, setCapabilities } from "../correct.ts";
import { itemAction } from "../define.ts";

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
              schema: z.enum(["Organization", "Party"]).meta({
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
