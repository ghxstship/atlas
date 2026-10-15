/**
 * Hospitality handlers (A11, RRR-23). Add one entry per operationId of the Hospitality module;
 * operations left out stay document-only. See "Adding handlers" in packages/api/README.md.
 *
 * The frozen v1 contract describes fulfillments, lines and BEOs with fields the schema does not
 * hold (engagement ids and units on fulfillments and lines, titles on BEOs, a required currency on
 * unpriced lines) and fulfillment states the lifecycle does not use (Quoted, Committed). Until A04C's
 * contract corrections land, only the deletes, whose shape the contract and schema share, are
 * served; every other Hospitality operation stays document-only rather than answer with invented
 * fields.
 */
import type { XosClient } from "@xos/data";
import { notFound } from "../problem.ts";
import { defineHandlers, noContent } from "../runtime/handler.ts";

type SoftDeletable = "fulfillments" | "fulfillment_lines" | "beos" | "beo_lines";

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

export const handlers = defineHandlers("Hospitality", {
  "fulfillments.delete": async ({ params }, { db }) =>
    softDelete(db, "fulfillments", params.id, "fulfillment"),
  "fulfillmentLines.delete": async ({ params }, { db }) =>
    softDelete(db, "fulfillment_lines", params.id, "fulfillment line"),
  "beos.delete": async ({ params }, { db }) => softDelete(db, "beos", params.id, "BEO"),
  "beoLines.delete": async ({ params }, { db }) =>
    softDelete(db, "beo_lines", params.id, "BEO line"),
});
