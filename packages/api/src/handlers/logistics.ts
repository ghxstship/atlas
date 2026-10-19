/**
 * Logistics handlers (A11 schema, A50 handlers). Shipments, their lines, dock slots, the gate queue
 * and the marshalling log are tables read and written as the caller in the shapes corrected in
 * catalog/modules/logistics.ts (ADR 0023), so row level security and the guards decide every
 * refusal. Dock check-in and gate release set their stamp column and the database stamps it once,
 * with its own time and the session person (guard_dock_check_in, guard_gate_release); the release
 * needs logistics.release.approve. The marshalling log is append-only.
 */
import { checkInDockSlot, releaseVehicle } from "@xos/data/logistics";
import { refused } from "../problem.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
import type { HandlerSet } from "../runtime/handler.ts";
import { tableResource, unwrap } from "./support/table.ts";

const shipments = tableResource("shipments");
const shipmentLines = tableResource("shipmentLines");
const dockSlots = tableResource("dockSlots");
const gateQueue = tableResource("gateQueueEntries");
const marshallingLog = tableResource("marshallingLogEntries");

const tables = {
  ...shipments.handlers,
  ...shipmentLines.handlers,
  ...dockSlots.handlers,
  ...gateQueue.handlers,
  ...marshallingLog.handlers,
} as unknown as HandlerSet<"Logistics">;

export const handlers = defineHandlers("Logistics", {
  ...tables,

  "dockSlots.checkIn": async ({ params }, context) => {
    const slot = await dockSlots.read(context, params.id, ["id", "checked_in_at"]);
    if (slot["checked_in_at"] !== null) {
      throw refused(
        "REFUSE",
        "The shipment is already checked in at this dock slot.",
        "dock_slot_checked_in",
      );
    }
    unwrap(await checkInDockSlot(context.db, params.id));
    return ok((await dockSlots.read(context, params.id)) as never);
  },

  "gateQueueEntries.release": async ({ params }, context) => {
    const entry = await gateQueue.read(context, params.id, ["id", "released_at"]);
    if (entry["released_at"] !== null) {
      throw refused("REFUSE", "The vehicle is already released into the site.", "vehicle_released");
    }
    unwrap(await releaseVehicle(context.db, params.id));
    return ok((await gateQueue.read(context, params.id)) as never);
  },
});
