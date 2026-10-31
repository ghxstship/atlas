/**
 * Hospitality operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Hospitality resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Hospitality resources follow ADR 0023 (A50).
 *
 * Fulfillments, their lines, BEOs and BEO lines are A03's tables of migration 0351 with A11's
 * display numbers and fulfillment lifecycle (0440). A line's price is nullable (unpriced) and so is
 * its currency, which every priced line must carry.
 */
import { z } from "@hono/zod-openapi";
import { fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, putActions, setCapabilities } from "../correct.ts";
import { transition } from "../define.ts";
import { groundTransportCapabilities, groundTransportResources } from "./parts/ground-transport-and-lodging.ts";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

const SINCE = "1.0.0-draft.2";

const lineCurrency = {
  currency_code: {
    schema: orNull(
      fields.currency("ISO 4217 currency of the price; required when the line is priced."),
    ),
    create: "optional" as const,
  },
};

export const additions = defineAdditions("Hospitality", {
  // Flights, transfers, vehicles, space bookings, local contacts and blocks by night (B5): see
  // ./parts/ground-transport-and-lodging.ts.
  resources: [...groundTransportResources],
  capabilities: { ...groundTransportCapabilities },
  corrections: [
    {
      id: "fulfillment-kind-counterparty-and-state",
      since: SINCE,
      resources: ["fulfillments"],
      change:
        "`kind` becomes `fulfillment_kind`; `engagement_id` gives way to `counterparty_id` (the supplier, nullable); adds the server-set `fulfillment_number`. `fulfillment_state` is Proposed, Active, Blocked, Complete or Canceled, and the transition example becomes Proposed to Active.",
      reason:
        "app.fulfillments (0351) names the kind `fulfillment_kind` and the supplier by `counterparty_id`; it has no engagement column. 0440 adds the project display number `fulfillment_number` and the lifecycle app.fulfillment_state, which has no Quoted or Committed state.",
      apply: all(
        editShape({
          rename: { kind: "fulfillment_kind" },
          remove: ["engagement_id"],
          add: {
            counterparty_id: {
              schema: orNull(fields.ref("supplier, such as the hotel or caterer")),
              create: "optional",
            },
            fulfillment_number: {
              schema: fields.int(
                "Number within the project; the display key is {project_key}-{fulfillment_number}.",
                3,
                1,
              ),
            },
            fulfillment_state: {
              schema: label(
                ["Proposed", "Active", "Blocked", "Complete", "Canceled"],
                "Fulfillment state.",
              ),
            },
          },
        }),
        putActions([transition("Fulfillment", ["Proposed", "Active"])]),
      ),
    },
    {
      id: "fulfillment-line-currency-and-guest",
      since: SINCE,
      resources: ["fulfillmentLines"],
      change:
        "`currency` becomes `currency_code`, nullable for an unpriced line; `unit` is removed; adds `person_id` (the guest, nullable); `quantity` defaults to 1 on create. Writes need hospitality.fulfillment.write.",
      reason:
        "app.fulfillment_lines (0351) names the column `currency_code` and lets it be NULL unless the line is priced (fulfillment_lines_price_currency), names the guest by `person_id`, has no unit column and defaults `quantity` to 1. install_child_table grants writes with hospitality.fulfillment.write.",
      apply: all(
        editShape({
          remove: ["unit", "currency"],
          optionalOnCreate: ["quantity"],
          add: {
            ...lineCurrency,
            person_id: {
              schema: orNull(fields.ref("guest the line is for, such as a room night")),
              create: "optional",
            },
          },
        }),
        setCapabilities({ write: "hospitality.fulfillment.write" }),
      ),
    },
    {
      id: "beo-event-time-and-approval",
      since: SINCE,
      resources: ["beos"],
      change:
        "`service_at` becomes `event_at`; `title` is removed; `guest_count` becomes nullable; adds the server-set `beo_number`, `approved_at` and `approved_by`.",
      reason:
        "app.beos (0351) has no title, names the service time `event_at`, leaves the guaranteed count NULL until known, and stamps `approved_at` and `approved_by` when someone with hospitality.beo.approve other than the author approves it (guard_beo). 0440 adds the display number `beo_number`.",
      apply: editShape({
        remove: ["title"],
        rename: { service_at: "event_at" },
        nullable: ["guest_count"],
        add: {
          beo_number: {
            schema: fields.int(
              "Number within the project; the display key is {project_key}-{beo_number}.",
              4,
              1,
            ),
          },
          approved_at: { schema: orNull(fields.instant("When the BEO was approved.")) },
          approved_by: {
            schema: orNull(fields.ref("person who approved the BEO; never its author")),
          },
        },
      }),
    },
    {
      id: "beo-line-currency",
      since: SINCE,
      resources: ["beoLines"],
      change:
        "`currency` becomes `currency_code`, nullable for an unpriced line; `quantity` defaults to 1 on create.",
      reason:
        "app.beo_lines (0351) names the column `currency_code` and lets it be NULL unless the line is priced (beo_lines_price_currency), and defaults `quantity` to 1.",
      apply: editShape({
        remove: ["currency"],
        optionalOnCreate: ["quantity"],
        add: lineCurrency,
      }),
    },
  ],
});
