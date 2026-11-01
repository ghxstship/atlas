/**
 * Hospitality handlers (A11 schema, A50 handlers). Fulfillments, their lines, BEOs and BEO lines are
 * tables read and written as the caller in the shapes corrected in catalog/modules/hospitality.ts
 * (ADR 0023), so row level security and the guards decide every refusal: lines of a Complete or
 * Canceled fulfillment never change, and a BEO's approval is stamped only by an approver other than
 * its author. A fulfillment moves through app.transition_fulfillment with compare-and-set.
 */
import { conflict } from "../problem.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
import type { HandlerSet } from "../runtime/handler.ts";
import { groundTransportHandlers } from "./parts/ground-transport-and-lodging.ts";
import { rpc, run, tableResource } from "./support/table.ts";

const fulfillments = tableResource("fulfillments");
const fulfillmentLines = tableResource("fulfillmentLines");
const beos = tableResource("beos");
const beoLines = tableResource("beoLines");

const tables = {
  ...fulfillments.handlers,
  ...fulfillmentLines.handlers,
  ...beos.handlers,
  ...beoLines.handlers,
} as unknown as HandlerSet<"Hospitality">;

export const handlers = defineHandlers("Hospitality", {
  ...tables,
  // Flights, transfers, vehicles, space bookings, local contacts and blocks by night (B5): see
  // ./parts/ground-transport-and-lodging.ts.
  ...groundTransportHandlers,

  "fulfillments.transition": async ({ params, body }, context) => {
    const current = await fulfillments.read(context, params.id, ["id", "fulfillment_state"]);
    if (current["fulfillment_state"] !== body.expected_state) {
      throw conflict(
        `The fulfillment is ${String(current["fulfillment_state"])}, not ${body.expected_state}; read it again before changing it.`,
      );
    }
    await run(
      rpc(context.db, "transition_fulfillment", {
        p_fulfillment_id: params.id,
        p_expected: body.expected_state,
        p_next: body.to_state,
        p_reason: body.reason ?? `Moved to ${body.to_state}.`,
      }),
    );
    return ok((await fulfillments.read(context, params.id)) as never);
  },
});
