/**
 * Allocations from the engaged party's side (R8, migrations 2700 and 2701). Reads go through the api_external views
 * as the caller, so the views' filters decide what each caller sees; writes go through the same @xos/data functions
 * Gateway calls, and refusals come back as 422 with the rule.
 */
import {
  requestEngagedAllocation,
  splitEngagedAllocation,
  unsplitEngagedAllocation,
  withdrawEngagedAllocation,
} from "@xos/data/gateway-allocations";
import type { HandlerSet } from "../../runtime/handler.ts";
import { created, ok } from "../../runtime/handler.ts";
import { handlersFor, tableResource, unwrap } from "../support/table.ts";

const engagedAllocations = tableResource("engagedAllocations", {
  softDelete: false,
  orgColumn: false,
  key: "allocation_id",
});
const requestableItems = tableResource("requestableItems", { softDelete: false, orgColumn: false });
const parkingPasses = tableResource("myParkingPasses", {
  softDelete: false,
  orgColumn: false,
  key: "credential_id",
});

export const engagedAllocationHandlers = {
  ...handlersFor("Gateway", engagedAllocations),
  ...handlersFor("Gateway", requestableItems),
  ...handlersFor("Gateway", parkingPasses),

  "engagedAllocations.request": async ({ body }, context) => {
    const id = unwrap(
      await requestEngagedAllocation(context.db, {
        engagementId: body.engagement_id,
        rosterEntryId: body.roster_entry_id ?? null,
        itemKind: body.item_kind,
        itemId: body.item_id ?? null,
        serviceKind: body.service_kind ?? null,
        quantity: body.quantity,
        neededFrom: body.needed_from,
        neededTo: body.needed_to,
        timeZone: body.time_zone,
        note: body.note ?? null,
      }),
    );
    return created((await engagedAllocations.read(context, id)) as never);
  },

  "engagedAllocations.split": async ({ params, body }, context) => {
    await engagedAllocations.read(context, params.allocation_id, ["allocation_id"]);
    const ids = unwrap(
      await splitEngagedAllocation(
        context.db,
        params.allocation_id,
        body.parts.map((p) => ({ rosterEntryId: p.roster_entry_id, quantity: p.quantity })),
      ),
    );
    return ok({ allocation_ids: ids });
  },

  "engagedAllocations.unsplit": async ({ params, body }, context) => {
    await engagedAllocations.read(context, params.allocation_id, ["allocation_id"]);
    return ok({
      quantity: unwrap(
        await unsplitEngagedAllocation(context.db, params.allocation_id, body.quantity),
      ),
    });
  },

  "engagedAllocations.withdraw": async ({ params, body }, context) => {
    await engagedAllocations.read(context, params.allocation_id, ["allocation_id"]);
    unwrap(
      await withdrawEngagedAllocation(
        context.db,
        params.allocation_id,
        body.reason ?? "Withdrawn through the API.",
      ),
    );
    return ok((await engagedAllocations.read(context, params.allocation_id)) as never);
  },
} satisfies HandlerSet<"Gateway">;
