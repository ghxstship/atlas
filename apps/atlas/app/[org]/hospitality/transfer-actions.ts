"use server";

import {
  addTransferPassenger,
  cancelTransfer,
  createTransfer,
  createTransferVehicle,
  deleteTransferVehicle,
  getTransfer,
  removeTransferPassenger,
  restoreTransfer,
  setPrimaryPassenger,
  updateTransfer,
  VEHICLE_TYPES,
  type TransferInput,
  type VehicleType,
} from "@xos/data/transfers";
import {
  cancelSpaceBooking,
  createSpaceBooking,
  SPACE_BOOKING_MODES,
  SPACE_BOOKING_PURPOSES,
  updateSpaceBooking,
  type SpaceBookingInput,
} from "@xos/data/space-bookings";
import { z } from "zod";
import {
  contextFor,
  contextForSlug,
  failed,
  field,
  optionalText,
  optionalUuid,
  projectFor,
  refresh,
  requiredText,
  uuid,
  zonedInstant,
  type ActionState,
} from "@/lib/logistics-hospitality/actions-kit";

/**
 * Ground transfer, vehicle and space booking actions (B5, ADR 0144). Times are typed in the project's zone and stored
 * with it. The database decides every refusal (double booking, a full vehicle, the driver as a passenger, a person off
 * the project, overlapping exclusive bookings), returned as keys under logistics.common.errors.
 */

const vehicleType = z.enum(VEHICLE_TYPES as [string, ...string[]]);
const purpose = z.enum(SPACE_BOOKING_PURPOSES as [string, ...string[]]);
const bookingMode = z.enum(SPACE_BOOKING_MODES as [string, ...string[]]);

function transferInput(
  form: FormData,
  timeZone: string,
): { input?: TransferInput; fieldErrors?: Record<string, string> } {
  const fieldErrors: Record<string, string> = {};
  const pickupPlace = requiredText(200).safeParse(field(form, "pickupPlace"));
  const dropoffPlace = requiredText(200).safeParse(field(form, "dropoffPlace"));
  const pickupAt = zonedInstant(form, "pickupAt", timeZone);
  const dropoffAt = zonedInstant(form, "dropoffAt", timeZone);
  const vehicle = optionalUuid.safeParse(field(form, "vehicleId"));
  const driver = optionalUuid.safeParse(field(form, "driverPersonId"));
  const meets = optionalUuid.safeParse(field(form, "meetsSegmentId"));
  const notes = optionalText(1000).safeParse(field(form, "notes"));
  if (!pickupPlace.success) fieldErrors["pickupPlace"] = "required";
  if (!dropoffPlace.success) fieldErrors["dropoffPlace"] = "required";
  if (!pickupAt) fieldErrors["pickupAt"] = pickupAt === null ? "required" : "dateTime";
  if (!dropoffAt) fieldErrors["dropoffAt"] = dropoffAt === null ? "required" : "dateTime";
  if (pickupAt && dropoffAt && dropoffAt <= pickupAt) fieldErrors["dropoffAt"] = "window";
  if (!notes.success) fieldErrors["notes"] = "tooLong";
  if (
    !pickupPlace.success ||
    !dropoffPlace.success ||
    !pickupAt ||
    !dropoffAt ||
    Object.keys(fieldErrors).length > 0
  ) {
    return { fieldErrors };
  }
  return {
    input: {
      fulfillmentId: null,
      vehicleId: vehicle.success ? vehicle.data : null,
      driverPersonId: driver.success ? driver.data : null,
      pickupPlace: pickupPlace.data,
      pickupAt,
      pickupTimeZone: timeZone,
      dropoffPlace: dropoffPlace.data,
      dropoffAt,
      dropoffTimeZone: timeZone,
      meetsSegmentId: meets.success ? meets.data : null,
      notes: notes.success ? notes.data : null,
    },
  };
}

export async function createTransferAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const projectId = uuid.safeParse(field(form, "projectId"));
  const project = projectId.success ? await projectFor(ctx, projectId.data) : null;
  if (!project) return { fieldErrors: { projectId: "required" } };
  const { input, fieldErrors } = transferInput(form, project.timeZone);
  if (!input) return { fieldErrors: fieldErrors ?? {} };
  const created = await createTransfer(ctx.viewer.db, project.id, input);
  if (!created.ok) return failed(created);
  // A pickup booked from the travel party carries its passenger.
  const passenger = optionalUuid.safeParse(field(form, "passengerPersonId"));
  if (passenger.success && passenger.data) {
    const added = await addTransferPassenger(ctx.viewer.db, created.data.id, passenger.data, true);
    if (!added.ok) {
      await cancelTransfer(ctx.viewer.db, created.data.id);
      return failed(added);
    }
  }
  refresh(ctx);
  const detail = await getTransfer(ctx.viewer.db, created.data.id);
  return detail.ok ? { ok: true, key: detail.data.key } : { ok: true };
}

export async function updateTransferAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(field(form, "id"));
  if (!id.success) return { error: "notFound" };
  const current = await getTransfer(ctx.viewer.db, id.data);
  if (!current.ok) return failed(current);
  const { input, fieldErrors } = transferInput(form, current.data.pickupTimeZone);
  if (!input) return { fieldErrors: fieldErrors ?? {} };
  const updated = await updateTransfer(ctx.viewer.db, id.data, {
    ...input,
    fulfillmentId: current.data.fulfillmentId,
  });
  if (!updated.ok) return failed(updated);
  refresh(ctx);
  return { ok: true };
}

export async function cancelTransferAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await cancelTransfer(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function restoreTransferAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await restoreTransfer(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function addPassengerAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const transferId = uuid.safeParse(field(form, "transferId"));
  const person = uuid.safeParse(field(form, "personId"));
  if (!transferId.success) return { error: "notFound" };
  if (!person.success) return { fieldErrors: { personId: "required" } };
  const result = await addTransferPassenger(
    ctx.viewer.db,
    transferId.data,
    person.data,
    field(form, "isPrimary") === "1",
  );
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function removePassengerAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await removeTransferPassenger(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function setPrimaryPassengerAction(
  org: string,
  transferId: string,
  passengerId: string,
): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await setPrimaryPassenger(
    ctx.viewer.db,
    uuid.parse(transferId),
    uuid.parse(passengerId),
  );
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function createVehicleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const projectId = uuid.safeParse(field(form, "projectId"));
  const project = projectId.success ? await projectFor(ctx, projectId.data) : null;
  if (!project) return { fieldErrors: { projectId: "required" } };
  const label = requiredText(60).safeParse(field(form, "label"));
  const type = vehicleType.safeParse(field(form, "vehicleType"));
  const seats = Number(field(form, "seats"));
  const supplier = optionalUuid.safeParse(field(form, "supplierId"));
  const fieldErrors: Record<string, string> = {};
  if (!label.success) fieldErrors["label"] = "required";
  if (!type.success) fieldErrors["vehicleType"] = "required";
  if (!Number.isInteger(seats) || seats < 1 || seats > 80) fieldErrors["seats"] = "seats";
  if (!label.success || !type.success || Object.keys(fieldErrors).length > 0)
    return { fieldErrors };
  const result = await createTransferVehicle(ctx.viewer.db, project.id, {
    label: label.data,
    vehicleType: type.data as VehicleType,
    seats,
    supplierId: supplier.success ? supplier.data : null,
  });
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function deleteVehicleAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await deleteTransferVehicle(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function restoreVehicleAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await deleteTransferVehicle(ctx.viewer.db, uuid.parse(id), false);
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

// Space bookings -----------------------------------------------------------------------------------------------------

function bookingInput(
  form: FormData,
  timeZone: string,
): { input?: SpaceBookingInput; fieldErrors?: Record<string, string> } {
  const fieldErrors: Record<string, string> = {};
  const space = uuid.safeParse(field(form, "spaceId"));
  const p = purpose.safeParse(field(form, "purpose"));
  const m = bookingMode.safeParse(field(form, "mode"));
  const engagement = optionalUuid.safeParse(field(form, "engagementId"));
  const cue = optionalUuid.safeParse(field(form, "engagementCueId"));
  const startsAt = zonedInstant(form, "startsAt", timeZone);
  const endsAt = zonedInstant(form, "endsAt", timeZone);
  const partyRaw = field(form, "partySize").trim();
  const party = partyRaw === "" ? null : Number(partyRaw);
  const notes = optionalText(1000).safeParse(field(form, "notes"));
  if (!space.success) fieldErrors["spaceId"] = "required";
  if (!p.success) fieldErrors["purpose"] = "required";
  if (!m.success) fieldErrors["mode"] = "required";
  if (!startsAt) fieldErrors["startsAt"] = startsAt === null ? "required" : "dateTime";
  if (!endsAt) fieldErrors["endsAt"] = endsAt === null ? "required" : "dateTime";
  if (startsAt && endsAt && endsAt <= startsAt) fieldErrors["endsAt"] = "window";
  if (party !== null && (!Number.isInteger(party) || party < 1 || party > 500))
    fieldErrors["partySize"] = "partySize";
  if (!notes.success) fieldErrors["notes"] = "tooLong";
  if (
    !space.success ||
    !p.success ||
    !m.success ||
    !startsAt ||
    !endsAt ||
    Object.keys(fieldErrors).length > 0
  ) {
    return { fieldErrors };
  }
  return {
    input: {
      spaceId: space.data,
      engagementId: engagement.success ? engagement.data : null,
      engagementCueId: cue.success ? cue.data : null,
      purpose: p.data as SpaceBookingInput["purpose"],
      mode: m.data as SpaceBookingInput["mode"],
      partySize: party,
      startsAt,
      endsAt,
      notes: notes.success ? notes.data : null,
    },
  };
}

export async function createBookingAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const projectId = uuid.safeParse(field(form, "projectId"));
  const project = projectId.success ? await projectFor(ctx, projectId.data) : null;
  if (!project) return { fieldErrors: { projectId: "required" } };
  const { input, fieldErrors } = bookingInput(form, project.timeZone);
  if (!input) return { fieldErrors: fieldErrors ?? {} };
  const result = await createSpaceBooking(ctx.viewer.db, project.id, input);
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function updateBookingAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(field(form, "id"));
  const projectId = uuid.safeParse(field(form, "projectId"));
  const project = projectId.success ? await projectFor(ctx, projectId.data) : null;
  if (!id.success || !project) return { error: "notFound" };
  const { input, fieldErrors } = bookingInput(form, project.timeZone);
  if (!input) return { fieldErrors: fieldErrors ?? {} };
  const result = await updateSpaceBooking(ctx.viewer.db, id.data, input);
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function cancelBookingAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await cancelSpaceBooking(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function restoreBookingAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await cancelSpaceBooking(ctx.viewer.db, uuid.parse(id), false);
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}
