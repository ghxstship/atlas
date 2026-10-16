/**
 * Logistics handlers (A11, RRR-23). Add one entry per operationId of the Logistics module;
 * operations left out stay document-only. See "Adding handlers" in packages/api/README.md.
 *
 * The frozen v1 contract describes shipments, dock slots, the gate queue and the marshalling log
 * with fields the schema does not hold (a carrier name instead of a counterparty, shipment states,
 * venue and dock names instead of a project and zone, vehicle plates on the log). Until A04C's
 * contract corrections land, only the deletes, whose shape the contract and schema share, are
 * served; every other Logistics operation stays document-only rather than answer with invented
 * fields.
 */
import type { XosClient } from "@xos/data";
import { notFound } from "../problem.ts";
import { defineHandlers, noContent } from "../runtime/handler.ts";

type SoftDeletable = "shipments" | "shipment_lines" | "dock_slots";

/** Moves a row to Trash (deleted_at), restorable for its retention period; 404 when not visible. */
async function softDelete(db: XosClient, table: SoftDeletable, id: string, label: string) {
  const { data, error } = await db
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound(`No ${label} with id ${id} is visible to you.`);
  return noContent();
}

export const handlers = defineHandlers("Logistics", {
  "shipments.delete": async ({ params }, { db }) =>
    softDelete(db, "shipments", params.id, "shipment"),
  "shipmentLines.delete": async ({ params }, { db }) =>
    softDelete(db, "shipment_lines", params.id, "shipment line"),
  "dockSlots.delete": async ({ params }, { db }) =>
    softDelete(db, "dock_slots", params.id, "dock slot"),
});
