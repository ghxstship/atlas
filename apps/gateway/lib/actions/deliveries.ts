"use server";

import {
  bookDeliveryWindow,
  cancelDeliveryBooking,
  setDeliveryBookingVehicle,
} from "@xos/data/delivery-windows";
import { z } from "zod";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import { createServerSupabase } from "@/lib/supabase/server";
import type { FormResult } from "./operations";

/**
 * Delivery self-booking (B11, G-115, ADR 0150). Each action validates its input and lets the database decide who may
 * book: an operational Vendor engagement of the project. Refusals come back as catalog copy through the outcome keys.
 */
const id = z.uuid();

export async function bookDeliveryAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({
      eventId: id,
      engagementId: id,
      windowId: id,
      vehicleIdentifier: z.string().trim().max(40),
      shipmentId: z.union([id, z.literal("")]),
    })
    .safeParse({
      eventId: form.get("eventId"),
      engagementId: form.get("engagementId"),
      windowId: form.get("windowId"),
      vehicleIdentifier: form.get("vehicleIdentifier") ?? "",
      shipmentId: form.get("shipmentId") ?? "",
    });
  if (!parsed.success) return { fieldError: "deliveryWindow" };
  const result = await bookDeliveryWindow(await createServerSupabase(), {
    eventId: parsed.data.eventId,
    windowId: parsed.data.windowId,
    engagementId: parsed.data.engagementId,
    vehicleIdentifier: parsed.data.vehicleIdentifier || null,
    shipmentId: parsed.data.shipmentId || null,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function cancelDeliveryBookingAction(slotId: string): Promise<ActionResult> {
  return toAction(await cancelDeliveryBooking(await createServerSupabase(), id.parse(slotId)));
}

export async function changeDeliveryPlateAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({ slotId: id, vehicleIdentifier: z.string().trim().max(40) })
    .safeParse({
      slotId: form.get("slotId"),
      vehicleIdentifier: form.get("vehicleIdentifier") ?? "",
    });
  if (!parsed.success) return { fieldError: "deliveryPlate" };
  const result = await setDeliveryBookingVehicle(
    await createServerSupabase(),
    parsed.data.slotId,
    parsed.data.vehicleIdentifier || null,
  );
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}
