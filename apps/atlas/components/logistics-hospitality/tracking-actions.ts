"use server";

import type { DataError } from "@xos/data";
import { asDbClient, startTracking, stopTracking } from "@xos/integrations";
import { z } from "zod";
import { contextFor, contextForSlug, refresh } from "@/lib/logistics-hospitality/actions-kit";
import { observability } from "@/lib/observability";

/**
 * Carrier tracking on a shipment (A19 0634, Section 17): start through a Connected carrier
 * connection, or stop. Each runs as the signed-in person, so the 0634 policies and guards decide;
 * a refusal comes back as a key under `shipmentTracking.errors`.
 */

export interface TrackingState {
  readonly ok?: boolean;
  readonly error?: string;
}

const KNOWN = new Set([
  "tracking_number_required",
  "integration_not_connected",
  "integration_category_mismatch",
]);

function errorOf(error: DataError): string {
  if (error.kind === "refusal") return KNOWN.has(error.rule) ? error.rule : "refused";
  if (error.kind === "conflict") return "alreadyTracked";
  if (error.kind === "invalid") return "numberFormat";
  if (error.kind === "not-found") return "notFound";
  observability.logger.error("Shipment tracking action failed", { error: error });
  return "unexpected";
}

export async function startTrackingAction(
  _: TrackingState,
  form: FormData,
): Promise<TrackingState> {
  const parsed = z
    .object({
      shipmentId: z.uuid(),
      connectionId: z.uuid(),
      trackingNumber: z
        .string()
        .trim()
        .regex(/^([A-Za-z0-9]{6,40})?$/),
    })
    .safeParse({
      shipmentId: form.get("shipmentId"),
      connectionId: form.get("connectionId"),
      trackingNumber: form.get("trackingNumber") ?? "",
    });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return { error: field === "connectionId" ? "carrierRequired" : "numberFormat" };
  }
  const ctx = await contextFor(form);
  const result = await startTracking(
    asDbClient(ctx.viewer.db),
    parsed.data.shipmentId,
    parsed.data.connectionId,
    parsed.data.trackingNumber.length > 0 ? parsed.data.trackingNumber : undefined,
  );
  if (!result.ok) return { error: errorOf(result.error) };
  refresh(ctx);
  return { ok: true };
}

export async function stopTrackingAction(org: string, trackerId: string): Promise<TrackingState> {
  const ctx = await contextForSlug(org);
  const result = await stopTracking(asDbClient(ctx.viewer.db), z.uuid().parse(trackerId));
  if (!result.ok) return { error: errorOf(result.error) };
  refresh(ctx);
  return { ok: true };
}
