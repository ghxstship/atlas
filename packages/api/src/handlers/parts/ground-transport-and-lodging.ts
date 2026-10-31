/**
 * Flights, transfers, vehicles, space bookings, local contacts and blocks by night (B5 2940 to 2946; ADR 0144). Each
 * resource reads its view as the caller, so the views' policies decide every row. The flight grid reads Flight rows
 * only, so a Ground segment never appears under that name. The two queries go straight to their RPCs, which answer
 * 42501 (404 here) without hospitality.fulfillment.read; the rooming list logs every person it returns.
 */
import type { Components } from "../../contract/operations.generated.ts";
import type { HandlerSet } from "../../runtime/handler.ts";
import { ok } from "../../runtime/handler.ts";
import { handlersFor, rpc, run, tableResource } from "../support/table.ts";
import type { Row } from "../support/table.ts";

const flights = tableResource("flights", {
  softDelete: false,
  scope: (query) => query.eq("travel_mode", "Flight"),
});
const transfers = tableResource("transfers", { softDelete: false });
const transferVehicles = tableResource("transferVehicles");
const spaceBookings = tableResource("spaceBookings", { softDelete: false });
const localContacts = tableResource("localContacts", { softDelete: false });
const accommodationNights = tableResource("accommodationNights", { softDelete: false, key: "night" });

const page = <T>(data: T[]) => ({ data, next_cursor: null });

export const groundTransportHandlers = {
  ...handlersFor("Hospitality", flights),
  ...handlersFor("Hospitality", transfers),
  ...handlersFor("Hospitality", transferVehicles),
  ...handlersFor("Hospitality", spaceBookings),
  ...handlersFor("Hospitality", localContacts),
  ...handlersFor("Hospitality", accommodationNights),

  "accommodationNights.actsWithoutRooms": async ({ query }, context) =>
    ok(
      page(
        await run<Components["ActWithoutRoom"][]>(
          rpc(context.db, "acts_without_rooms", { p_project_id: query.project_id }),
        ),
      ),
    ),

  "accommodationNights.roomingList": async ({ query }, context) =>
    ok(
      page(
        await run<Row[]>(rpc(context.db, "rooming_list", { p_project_id: query.project_id })),
      ) as never,
    ),
} satisfies Partial<HandlerSet<"Hospitality">>;
