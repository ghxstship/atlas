"use server";

import {
  addMarshallingEntry,
  addShipmentLine,
  bookDockSlot,
  cancelDockSlot,
  checkInDockSlot,
  createShipment,
  deleteShipment,
  getShipment,
  recordGateArrival,
  releaseVehicle,
  removeShipmentLine,
  restoreDockSlot,
  restoreShipment,
  updateDockSlot,
  updateShipment,
  SHIPMENT_DIRECTIONS,
  type ShipmentInput,
} from "@xos/data/logistics";
import { z } from "zod";
import {
  contextFor,
  contextForSlug,
  failed,
  field,
  optionalText,
  optionalUuid,
  projectFor,
  quantity,
  refresh,
  requiredText,
  uuid,
  zonedInstant,
  type ActionState,
} from "@/lib/logistics-hospitality/actions-kit";

/**
 * Logistics actions (A11, journey 20): log a shipment and its manifest, book and check in dock slots,
 * record gate arrivals and releases, and append to the marshalling yard log.
 */

const direction = z.enum(SHIPMENT_DIRECTIONS as [string, ...string[]]);

function shipmentInput(
  form: FormData,
  timeZone: string,
): { input?: ShipmentInput; fieldErrors?: Record<string, string> } {
  const fieldErrors: Record<string, string> = {};
  const dir = direction.safeParse(field(form, "direction"));
  if (!dir.success) fieldErrors["direction"] = "required";
  const carrier = optionalUuid.safeParse(field(form, "carrierId"));
  const freight = optionalText(20).safeParse(field(form, "freightTypeId"));
  const tracking = optionalText(100).safeParse(field(form, "trackingIdentifier"));
  if (!tracking.success) fieldErrors["trackingIdentifier"] = "tooLong";
  const shipsAt = zonedInstant(form, "shipsAt", timeZone);
  const arrivesAt = zonedInstant(form, "arrivesAt", timeZone);
  if (shipsAt === undefined) fieldErrors["shipsAt"] = "dateTime";
  if (arrivesAt === undefined) fieldErrors["arrivesAt"] = "dateTime";
  if (shipsAt && arrivesAt && arrivesAt < shipsAt) fieldErrors["arrivesAt"] = "window";
  if (Object.keys(fieldErrors).length > 0 || !dir.success) return { fieldErrors };
  return {
    input: {
      direction: dir.data as ShipmentInput["direction"],
      carrierId: carrier.success ? carrier.data : null,
      freightTypeId: freight.success ? freight.data : null,
      trackingIdentifier: tracking.success ? tracking.data : null,
      shipsAt: shipsAt ?? null,
      arrivesAt: arrivesAt ?? null,
    },
  };
}

export async function createShipmentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const projectId = uuid.safeParse(field(form, "projectId"));
  if (!projectId.success) return { fieldErrors: { projectId: "required" } };
  const project = await projectFor(ctx, projectId.data);
  if (!project) return { fieldErrors: { projectId: "required" } };
  const { input, fieldErrors } = shipmentInput(form, project.timeZone);
  if (!input) return { fieldErrors: fieldErrors ?? {} };
  const created = await createShipment(ctx.viewer.db, project.id, input);
  if (!created.ok) return failed(created);
  refresh(ctx);
  const shipment = await getShipment(ctx.viewer.db, created.data.id);
  return shipment.ok ? { ok: true, key: shipment.data.key } : { ok: true };
}

export async function updateShipmentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(field(form, "id"));
  if (!id.success) return { error: "notFound" };
  const current = await getShipment(ctx.viewer.db, id.data);
  if (!current.ok) return failed(current);
  const { input, fieldErrors } = shipmentInput(form, current.data.timeZone);
  if (!input) return { fieldErrors: fieldErrors ?? {} };
  const updated = await updateShipment(
    ctx.viewer.db,
    id.data,
    input,
    field(form, "expectedUpdatedAt") || undefined,
  );
  if (!updated.ok) return failed(updated);
  refresh(ctx);
  return { ok: true, key: current.data.key };
}

export async function deleteShipmentAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await deleteShipment(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function restoreShipmentAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await restoreShipment(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function addShipmentLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const shipmentId = uuid.safeParse(field(form, "shipmentId"));
  if (!shipmentId.success) return { error: "notFound" };
  const description = requiredText(300).safeParse(field(form, "description"));
  const qty = quantity(field(form, "quantity") || "1");
  const fieldErrors: Record<string, string> = {};
  if (!description.success) fieldErrors["description"] = "required";
  if (qty === undefined) fieldErrors["quantity"] = "quantity";
  if (!description.success || qty === undefined) return { fieldErrors };
  const result = await addShipmentLine(ctx.viewer.db, shipmentId.data, {
    description: description.data,
    quantity: qty,
  });
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function removeShipmentLineAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await removeShipmentLine(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function bookDockSlotAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const projectId = uuid.safeParse(field(form, "projectId"));
  const project = projectId.success ? await projectFor(ctx, projectId.data) : null;
  if (!project) return { fieldErrors: { projectId: "required" } };
  const zoneId = uuid.safeParse(field(form, "zoneId"));
  const shipmentId = optionalUuid.safeParse(field(form, "shipmentId"));
  const startsAt = zonedInstant(form, "startsAt", project.timeZone);
  const endsAt = zonedInstant(form, "endsAt", project.timeZone);
  const fieldErrors: Record<string, string> = {};
  if (!zoneId.success) fieldErrors["zoneId"] = "required";
  if (!startsAt) fieldErrors["startsAt"] = startsAt === null ? "required" : "dateTime";
  if (!endsAt) fieldErrors["endsAt"] = endsAt === null ? "required" : "dateTime";
  if (startsAt && endsAt && endsAt <= startsAt) fieldErrors["endsAt"] = "window";
  if (!zoneId.success || !startsAt || !endsAt || Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }
  const input = {
    zoneId: zoneId.data,
    shipmentId: shipmentId.success ? shipmentId.data : null,
    startsAt,
    endsAt,
  };
  const slotId = optionalUuid.safeParse(field(form, "id"));
  const result =
    slotId.success && slotId.data
      ? await updateDockSlot(ctx.viewer.db, slotId.data, input)
      : await bookDockSlot(ctx.viewer.db, project.id, input);
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function checkInDockSlotAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await checkInDockSlot(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function cancelDockSlotAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await cancelDockSlot(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function restoreDockSlotAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await restoreDockSlot(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function recordGateArrivalAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const projectId = uuid.safeParse(field(form, "projectId"));
  if (!projectId.success) return { fieldErrors: { projectId: "required" } };
  const vehicle = requiredText(40).safeParse(field(form, "vehicleIdentifier"));
  if (!vehicle.success) return { fieldErrors: { vehicleIdentifier: "required" } };
  const shipmentId = optionalUuid.safeParse(field(form, "shipmentId"));
  const result = await recordGateArrival(ctx.viewer.db, projectId.data, {
    vehicleIdentifier: vehicle.data,
    shipmentId: shipmentId.success ? shipmentId.data : null,
  });
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function releaseVehicleAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await releaseVehicle(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function addYardEntryAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const projectId = uuid.safeParse(field(form, "projectId"));
  if (!projectId.success) return { fieldErrors: { projectId: "required" } };
  const entry = requiredText(1000).safeParse(field(form, "entry"));
  if (!entry.success) return { fieldErrors: { entry: "required" } };
  const shipmentId = optionalUuid.safeParse(field(form, "shipmentId"));
  const zoneId = optionalUuid.safeParse(field(form, "zoneId"));
  const result = await addMarshallingEntry(ctx.viewer.db, projectId.data, {
    entry: entry.data,
    shipmentId: shipmentId.success ? shipmentId.data : null,
    zoneId: zoneId.success ? zoneId.data : null,
  });
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}
