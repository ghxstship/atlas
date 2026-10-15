"use server";

import {
  addBeoLine,
  addFulfillmentLine,
  approveBeo,
  assignRoom,
  cancelTravelSegment,
  createAccommodationBlock,
  createBeo,
  createFulfillment,
  createTravelSegment,
  deleteAccommodationBlock,
  deleteBeo,
  deleteFulfillment,
  getAccommodationBlock,
  getBeo,
  getFulfillment,
  removeBeoLine,
  removeFulfillmentLine,
  removeRoomAssignment,
  restoreBeo,
  restoreFulfillment,
  transitionFulfillment,
  updateAccommodationBlock,
  updateBeo,
  updateFulfillment,
  listCurrencies,
  parseMinor,
  FULFILLMENT_KINDS,
  FULFILLMENT_STATES,
  TRAVEL_MODES,
  type AccommodationBlockInput,
  type FulfillmentInput,
  type FulfillmentState,
  type TravelMode,
} from "@xos/data/hospitality";
import type { XosClient } from "@xos/data";
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
 * Hospitality actions (A11, journey 21): fulfillments with their lifecycle and lines, BEOs with
 * approval, accommodation blocks with room assignments, and travel segments.
 */

const kind = z.enum(FULFILLMENT_KINDS as [string, ...string[]]);
const state = z.enum(FULFILLMENT_STATES as [string, ...string[]]);
const mode = z.enum(TRAVEL_MODES as [string, ...string[]]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);

/**
 * A price and its currency, read in that currency's minor unit exponent: unpriced when blank (never
 * zero), refused when a price has no known currency or more decimals than the currency allows.
 */
async function price(
  db: XosClient,
  form: FormData,
  amountName: string,
  fieldErrors: Record<string, string>,
): Promise<{ minor: number | null; currency: string | null }> {
  const raw = field(form, amountName);
  if (raw.trim() === "") return { minor: null, currency: null };
  const code = currency.safeParse(field(form, "currencyCode"));
  const currencies = await listCurrencies(db);
  const known =
    currencies.ok && code.success ? currencies.data.find((c) => c.code === code.data) : undefined;
  if (!known) {
    fieldErrors["currencyCode"] = "currency";
    return { minor: null, currency: null };
  }
  const minor = parseMinor(raw, known.exponent);
  if (minor === undefined) {
    fieldErrors[amountName] = "amount";
    return { minor: null, currency: null };
  }
  return { minor, currency: minor === null ? null : known.code };
}

// Fulfillments -------------------------------------------------------------------------------------

function fulfillmentInput(
  form: FormData,
  timeZone: string,
): { input?: FulfillmentInput; fieldErrors?: Record<string, string> } {
  const fieldErrors: Record<string, string> = {};
  const k = kind.safeParse(field(form, "kind"));
  const title = requiredText(200).safeParse(field(form, "title"));
  const supplier = optionalUuid.safeParse(field(form, "supplierId"));
  const startsAt = zonedInstant(form, "startsAt", timeZone);
  const endsAt = zonedInstant(form, "endsAt", timeZone);
  if (!k.success) fieldErrors["kind"] = "required";
  if (!title.success) fieldErrors["title"] = "required";
  if (startsAt === undefined) fieldErrors["startsAt"] = "dateTime";
  if (endsAt === undefined) fieldErrors["endsAt"] = "dateTime";
  if (startsAt && endsAt && endsAt < startsAt) fieldErrors["endsAt"] = "window";
  if (!k.success || !title.success || Object.keys(fieldErrors).length > 0) return { fieldErrors };
  return {
    input: {
      kind: k.data as FulfillmentInput["kind"],
      title: title.data,
      supplierId: supplier.success ? supplier.data : null,
      startsAt: startsAt ?? null,
      endsAt: endsAt ?? null,
    },
  };
}

export async function createFulfillmentAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const projectId = uuid.safeParse(field(form, "projectId"));
  const project = projectId.success ? await projectFor(ctx, projectId.data) : null;
  if (!project) return { fieldErrors: { projectId: "required" } };
  const { input, fieldErrors } = fulfillmentInput(form, project.timeZone);
  if (!input) return { fieldErrors: fieldErrors ?? {} };
  const created = await createFulfillment(ctx.viewer.db, project.id, input);
  if (!created.ok) return failed(created);
  refresh(ctx);
  const detail = await getFulfillment(ctx.viewer.db, created.data.id);
  return detail.ok ? { ok: true, key: detail.data.key } : { ok: true };
}

export async function updateFulfillmentAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(field(form, "id"));
  if (!id.success) return { error: "notFound" };
  const current = await getFulfillment(ctx.viewer.db, id.data);
  if (!current.ok) return failed(current);
  const { input, fieldErrors } = fulfillmentInput(form, current.data.timeZone);
  if (!input) return { fieldErrors: fieldErrors ?? {} };
  const updated = await updateFulfillment(
    ctx.viewer.db,
    id.data,
    input,
    field(form, "expectedUpdatedAt") || undefined,
  );
  if (!updated.ok) return failed(updated);
  refresh(ctx);
  return { ok: true, key: current.data.key };
}

export async function deleteFulfillmentAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await deleteFulfillment(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function restoreFulfillmentAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await restoreFulfillment(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function transitionFulfillmentAction(
  org: string,
  id: string,
  expected: string,
  next: string,
  reason: string,
): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const from = state.safeParse(expected);
  const to = state.safeParse(next);
  const why = requiredText(500).safeParse(reason);
  if (!from.success || !to.success) return { error: "fulfillment_transition_not_allowed" };
  if (!why.success) return { error: "transition_reason_required" };
  const result = await transitionFulfillment(
    ctx.viewer.db,
    uuid.parse(id),
    from.data as FulfillmentState,
    to.data as FulfillmentState,
    why.data,
  );
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function addFulfillmentLineAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const fulfillmentId = uuid.safeParse(field(form, "fulfillmentId"));
  if (!fulfillmentId.success) return { error: "notFound" };
  const fieldErrors: Record<string, string> = {};
  const description = requiredText(300).safeParse(field(form, "description"));
  const person = optionalUuid.safeParse(field(form, "personId"));
  const qty = quantity(field(form, "quantity") || "1");
  if (!description.success) fieldErrors["description"] = "required";
  if (qty === undefined) fieldErrors["quantity"] = "quantity";
  const p = await price(ctx.viewer.db, form, "unitPrice", fieldErrors);
  if (!description.success || qty === undefined || Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }
  const result = await addFulfillmentLine(ctx.viewer.db, fulfillmentId.data, {
    description: description.data,
    personId: person.success ? person.data : null,
    quantity: qty,
    unitPriceMinor: p.minor,
    currencyCode: p.currency,
  });
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function removeFulfillmentLineAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await removeFulfillmentLine(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

// BEOs ---------------------------------------------------------------------------------------------

async function beoInput(form: FormData, timeZone: string) {
  const fieldErrors: Record<string, string> = {};
  const fulfillmentId = optionalUuid.safeParse(field(form, "fulfillmentId"));
  const eventAt = zonedInstant(form, "eventAt", timeZone);
  const guestsRaw = field(form, "guestCount").trim();
  const guests = guestsRaw === "" ? null : Number(guestsRaw);
  if (!eventAt) fieldErrors["eventAt"] = eventAt === null ? "required" : "dateTime";
  if (guests !== null && (!Number.isInteger(guests) || guests <= 0)) {
    fieldErrors["guestCount"] = "guests";
  }
  if (!eventAt || Object.keys(fieldErrors).length > 0) return { fieldErrors };
  return {
    input: {
      fulfillmentId: fulfillmentId.success ? fulfillmentId.data : null,
      eventAt,
      guestCount: guests,
    },
  };
}

export async function createBeoAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const projectId = uuid.safeParse(field(form, "projectId"));
  const project = projectId.success ? await projectFor(ctx, projectId.data) : null;
  if (!project) return { fieldErrors: { projectId: "required" } };
  const { input, fieldErrors } = await beoInput(form, project.timeZone);
  if (!input) return { fieldErrors };
  const created = await createBeo(ctx.viewer.db, project.id, input);
  if (!created.ok) return failed(created);
  refresh(ctx);
  const detail = await getBeo(ctx.viewer.db, created.data.id);
  return detail.ok ? { ok: true, key: detail.data.key } : { ok: true };
}

export async function updateBeoAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(field(form, "id"));
  if (!id.success) return { error: "notFound" };
  const current = await getBeo(ctx.viewer.db, id.data);
  if (!current.ok) return failed(current);
  const { input, fieldErrors } = await beoInput(form, current.data.timeZone);
  if (!input) return { fieldErrors };
  const updated = await updateBeo(ctx.viewer.db, id.data, input);
  if (!updated.ok) return failed(updated);
  refresh(ctx);
  return { ok: true, key: current.data.key };
}

export async function approveBeoAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await approveBeo(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function deleteBeoAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await deleteBeo(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function restoreBeoAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await restoreBeo(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function addBeoLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const beoId = uuid.safeParse(field(form, "beoId"));
  if (!beoId.success) return { error: "notFound" };
  const fieldErrors: Record<string, string> = {};
  const description = requiredText(300).safeParse(field(form, "description"));
  const qty = quantity(field(form, "quantity") || "1");
  if (!description.success) fieldErrors["description"] = "required";
  if (qty === undefined) fieldErrors["quantity"] = "quantity";
  const p = await price(ctx.viewer.db, form, "unitPrice", fieldErrors);
  if (!description.success || qty === undefined || Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }
  const result = await addBeoLine(ctx.viewer.db, beoId.data, {
    description: description.data,
    quantity: qty,
    unitPriceMinor: p.minor,
    currencyCode: p.currency,
  });
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function removeBeoLineAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await removeBeoLine(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

// Accommodation blocks ------------------------------------------------------------------------------

async function blockInput(
  db: XosClient,
  form: FormData,
): Promise<{
  input?: AccommodationBlockInput;
  fieldErrors?: Record<string, string>;
}> {
  const fieldErrors: Record<string, string> = {};
  const title = requiredText(200).safeParse(field(form, "title"));
  const hotel = optionalUuid.safeParse(field(form, "hotelId"));
  const checkIn = isoDate.safeParse(field(form, "checkInOn"));
  const checkOut = isoDate.safeParse(field(form, "checkOutOn"));
  const releaseRaw = field(form, "releaseOn");
  const release = releaseRaw === "" ? null : isoDate.safeParse(releaseRaw);
  const rooms = Number(field(form, "roomsHeld"));
  if (!title.success) fieldErrors["title"] = "required";
  if (!checkIn.success) fieldErrors["checkInOn"] = "date";
  if (!checkOut.success) fieldErrors["checkOutOn"] = "date";
  if (checkIn.success && checkOut.success && checkOut.data <= checkIn.data) {
    fieldErrors["checkOutOn"] = "window";
  }
  if (release && !release.success) fieldErrors["releaseOn"] = "date";
  if (!Number.isInteger(rooms) || rooms < 1) fieldErrors["roomsHeld"] = "rooms";
  const p = await price(db, form, "nightlyRate", fieldErrors);
  if (
    !title.success ||
    !checkIn.success ||
    !checkOut.success ||
    Object.keys(fieldErrors).length > 0
  ) {
    return { fieldErrors };
  }
  return {
    input: {
      title: title.data,
      hotelId: hotel.success ? hotel.data : null,
      checkInOn: checkIn.data,
      checkOutOn: checkOut.data,
      roomsHeld: rooms,
      releaseOn: release && release.success ? release.data : null,
      nightlyRateMinor: p.minor,
      currencyCode: p.currency,
    },
  };
}

export async function createBlockAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const projectId = uuid.safeParse(field(form, "projectId"));
  const project = projectId.success ? await projectFor(ctx, projectId.data) : null;
  if (!project) return { fieldErrors: { projectId: "required" } };
  const { input, fieldErrors } = await blockInput(ctx.viewer.db, form);
  if (!input) return { fieldErrors: fieldErrors ?? {} };
  const created = await createAccommodationBlock(ctx.viewer.db, project.id, input);
  if (!created.ok) return failed(created);
  refresh(ctx);
  const detail = await getAccommodationBlock(ctx.viewer.db, created.data.id);
  return detail.ok ? { ok: true, key: detail.data.key } : { ok: true };
}

export async function updateBlockAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(field(form, "id"));
  if (!id.success) return { error: "notFound" };
  const { input, fieldErrors } = await blockInput(ctx.viewer.db, form);
  if (!input) return { fieldErrors: fieldErrors ?? {} };
  const updated = await updateAccommodationBlock(
    ctx.viewer.db,
    id.data,
    input,
    field(form, "expectedUpdatedAt") || undefined,
  );
  if (!updated.ok) return failed(updated);
  refresh(ctx);
  return { ok: true };
}

export async function deleteBlockAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await deleteAccommodationBlock(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function restoreBlockAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await deleteAccommodationBlock(ctx.viewer.db, uuid.parse(id), false);
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function assignRoomAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const blockId = uuid.safeParse(field(form, "blockId"));
  if (!blockId.success) return { error: "notFound" };
  const person = uuid.safeParse(field(form, "personId"));
  const checkIn = isoDate.safeParse(field(form, "checkInOn"));
  const checkOut = isoDate.safeParse(field(form, "checkOutOn"));
  const fieldErrors: Record<string, string> = {};
  if (!person.success) fieldErrors["personId"] = "required";
  if (!checkIn.success) fieldErrors["checkInOn"] = "date";
  if (!checkOut.success) fieldErrors["checkOutOn"] = "date";
  if (checkIn.success && checkOut.success && checkOut.data <= checkIn.data) {
    fieldErrors["checkOutOn"] = "window";
  }
  if (
    !person.success ||
    !checkIn.success ||
    !checkOut.success ||
    Object.keys(fieldErrors).length > 0
  ) {
    return { fieldErrors };
  }
  const result = await assignRoom(ctx.viewer.db, blockId.data, {
    personId: person.data,
    checkInOn: checkIn.data,
    checkOutOn: checkOut.data,
  });
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function removeRoomAssignmentAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await removeRoomAssignment(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

// Travel -------------------------------------------------------------------------------------------

export async function createTravelAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const fulfillmentId = uuid.safeParse(field(form, "fulfillmentId"));
  if (!fulfillmentId.success) return { error: "notFound" };
  const fulfillment = await getFulfillment(ctx.viewer.db, fulfillmentId.data);
  if (!fulfillment.ok) return failed(fulfillment);
  const tz = fulfillment.data.timeZone;
  const fieldErrors: Record<string, string> = {};
  const person = uuid.safeParse(field(form, "personId"));
  const m = mode.safeParse(field(form, "mode"));
  const from = requiredText(200).safeParse(field(form, "departsFrom"));
  const to = requiredText(200).safeParse(field(form, "arrivesAtPlace"));
  const operator = optionalText(120).safeParse(field(form, "operatorName"));
  const service = optionalText(40).safeParse(field(form, "serviceIdentifier"));
  const confirmation = optionalText(40).safeParse(field(form, "confirmationIdentifier"));
  const departsAt = zonedInstant(form, "departsAt", tz);
  const arrivesAt = zonedInstant(form, "arrivesAt", tz);
  if (!person.success) fieldErrors["personId"] = "required";
  if (!m.success) fieldErrors["mode"] = "required";
  if (!from.success) fieldErrors["departsFrom"] = "required";
  if (!to.success) fieldErrors["arrivesAtPlace"] = "required";
  if (!operator.success) fieldErrors["operatorName"] = "tooLong";
  if (!service.success) fieldErrors["serviceIdentifier"] = "tooLong";
  if (!confirmation.success) fieldErrors["confirmationIdentifier"] = "tooLong";
  if (!departsAt) fieldErrors["departsAt"] = departsAt === null ? "required" : "dateTime";
  if (arrivesAt === undefined) fieldErrors["arrivesAt"] = "dateTime";
  if (departsAt && arrivesAt && arrivesAt < departsAt) fieldErrors["arrivesAt"] = "window";
  const p = await price(ctx.viewer.db, form, "fare", fieldErrors);
  if (
    !person.success ||
    !m.success ||
    !from.success ||
    !to.success ||
    !departsAt ||
    Object.keys(fieldErrors).length > 0
  ) {
    return { fieldErrors };
  }
  const result = await createTravelSegment(ctx.viewer.db, fulfillment.data.projectId, {
    personId: person.data,
    fulfillmentId: fulfillment.data.id,
    mode: m.data as TravelMode,
    operatorName: operator.success ? operator.data : null,
    serviceIdentifier: service.success ? service.data : null,
    confirmationIdentifier: confirmation.success ? confirmation.data : null,
    departsFrom: from.data,
    departsAt,
    departsTimeZone: tz,
    arrivesAtPlace: to.data,
    arrivesAt: arrivesAt ?? null,
    arrivesTimeZone: tz,
    priceMinor: p.minor,
    currencyCode: p.currency,
  });
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function cancelTravelAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const result = await cancelTravelSegment(ctx.viewer.db, uuid.parse(id));
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}
