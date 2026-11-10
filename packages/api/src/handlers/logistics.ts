/**
 * Logistics handlers (A11 schema, A50 handlers). Shipments, their lines, dock slots, the gate queue
 * and the marshalling log are tables read and written as the caller in the shapes corrected in
 * catalog/modules/logistics.ts (ADR 0023), so row level security and the guards decide every
 * refusal. Dock check-in and gate release set their stamp column and the database stamps it once,
 * with its own time and the session person (guard_dock_check_in, guard_gate_release); the release
 * needs logistics.release.approve. The marshalling log is append-only.
 */
import { checkInDockSlot, releaseVehicle } from "@xos/data/logistics";
import {
  bookDeliveryWindow,
  cancelDeliveryBooking,
  createDeliveryWindows,
} from "@xos/data/delivery-windows";
import { refused } from "../problem.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
import type { HandlerSet } from "../runtime/handler.ts";
import { handlersFor, tableResource, unwrap } from "./support/table.ts";

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

const deliveryWindows = tableResource("deliveryWindows");

export const handlers = defineHandlers("Logistics", {
  ...tables,
  ...handlersFor("Logistics", deliveryWindows),

  // Delivery windows (B11, ADR 0150). The database decides who may book and refuses a full or closed window.
  "deliveryWindows.generate": async ({ body }, context) => {
    const created = unwrap(
      await createDeliveryWindows(context.db, {
        projectId: body.project_id,
        zoneId: body.zone_id,
        firstDay: body.first_day,
        lastDay: body.last_day,
        fromTime: body.from_time,
        toTime: body.to_time,
        slotMinutes: body.slot_minutes,
        vehicleLimit: body.vehicle_limit,
      }),
    );
    return ok({ data: created });
  },
  "deliveryWindows.book": async ({ params, body }, context) => {
    const booked = unwrap(
      await bookDeliveryWindow(context.db, {
        eventId: crypto.randomUUID(),
        windowId: params.id,
        engagementId: body.engagement_id ?? null,
        vehicleIdentifier: body.vehicle_identifier ?? null,
        shipmentId: body.shipment_id ?? null,
      }),
    );
    const slot = await dockSlots.read(context, booked.id, ["id", "reference_code"]);
    return ok({ dock_slot_id: booked.id, reference_code: String(slot["reference_code"]) });
  },
  "dockSlots.cancelBooking": async ({ params }, context) => {
    unwrap(await cancelDeliveryBooking(context.db, params.id));
    return ok({ id: params.id });
  },

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
