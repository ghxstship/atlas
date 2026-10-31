/**
 * Roster entries and their project facts (R4 2637, R5 2654 to 2657; ADR 0101 and 0102). The producing org lists and
 * reads entries through app.roster_entry_people. The project fact actions do not read the entry first: the person and
 * the company that rosters them are not producers and cannot see that view, so every call goes straight to its RPC,
 * which decides the caller's standing (42501, answered 404) and logs every read of a value by anyone but the person.
 * Refusals come back as 422 with the rule code.
 */
import type { Components } from "../../contract/operations.generated.ts";
import type { HandlerSet } from "../../runtime/handler.ts";
import { ok } from "../../runtime/handler.ts";
import { handlersFor, rpc, run, tableResource } from "../support/table.ts";
import type { Row } from "../support/table.ts";

const rosterEntries = tableResource("rosterEntries", { softDelete: false });

const page = <T>(data: T[]) => ({ data, next_cursor: null });

const orNull = <T>(value: T | null | undefined): T | null => (value === undefined ? null : value);

export const rosterEntryHandlers = {
  ...handlersFor("Advancing", rosterEntries),

  "rosterEntries.projectFacts": async ({ params }, context) =>
    ok(
      await run<Components["RosterProjectFacts"]>(
        rpc(context.db, "roster_project_facts", { p_roster_entry_id: params.id }),
      ),
    ),

  "rosterEntries.saveTravelRequest": async ({ params, body }, context) => {
    const id = await run<string>(
      rpc(context.db, "save_roster_travel_request", {
        p_roster_entry_id: params.id,
        p_inbound_airport_code: orNull(body.inbound_airport_code),
        p_outbound_airport_code: orNull(body.outbound_airport_code),
        p_inbound_on: orNull(body.inbound_on),
        p_outbound_on: orNull(body.outbound_on),
        p_seat_preference: orNull(body.seat_preference),
        p_meal_preference: orNull(body.meal_preference),
        p_needs_ground_transport: body.needs_ground_transport ?? false,
        p_needs_lodging: body.needs_lodging ?? false,
        p_travel_notes: orNull(body.travel_notes),
      }),
    );
    return ok({ id });
  },

  "rosterEntries.saveUniformSizes": async ({ params, body }, context) => {
    const id = await run<string>(
      rpc(context.db, "save_roster_uniform_sizes", {
        p_roster_entry_id: params.id,
        p_shirt_size: orNull(body.shirt_size),
        p_jacket_size: orNull(body.jacket_size),
        p_pants_size: orNull(body.pants_size),
        p_glove_size: orNull(body.glove_size),
        p_hat_size: orNull(body.hat_size),
        p_pants_waist_in: orNull(body.pants_waist_in),
        p_pants_inseam_in: orNull(body.pants_inseam_in),
        p_shoe_size: orNull(body.shoe_size),
        p_shoe_size_system: orNull(body.shoe_size_system),
      }),
    );
    return ok({ id });
  },

  "rosterEntries.saveVehicle": async ({ params, body }, context) => {
    const id = await run<string>(
      rpc(context.db, "save_roster_vehicle", {
        p_roster_entry_id: params.id,
        p_make: body.make,
        p_model: body.model,
        p_color: orNull(body.color),
        p_plate: body.plate,
        p_plate_region: body.plate_region,
      }),
    );
    return ok({ id });
  },

  "rosterEntries.clearProjectFact": async ({ params, body }, context) => {
    await run(
      rpc(context.db, "clear_roster_project_fact", {
        p_roster_entry_id: params.id,
        p_kind: body.kind,
      }),
    );
    return ok({});
  },

  "rosterEntries.travelParty": async ({ query }, context) =>
    ok(
      page(
        await run<Components["TravelPartyMember"][]>(
          rpc(context.db, "roster_travel_party", { p_project_id: query.project_id }),
        ),
      ),
    ),

  "rosterEntries.travelDayCounts": async ({ query }, context) =>
    ok(
      page(
        await run<Row[]>(
          rpc(context.db, "roster_travel_day_counts", { p_project_id: query.project_id }),
        ),
      ) as never,
    ),
} satisfies HandlerSet<"Advancing">;
