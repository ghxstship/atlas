"use server";

import { cateringCounts, type CateringCount } from "@xos/data/allocations";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";

/**
 * A catering's roster counts for the BEO (R7, app.catering_counts), read only when asked for: every call logs one
 * access-log row per person counted, so the page never reads them on its own.
 */
export async function rosterCountsAction(
  org: string,
  fulfillmentId: string,
): Promise<CateringCount[] | null> {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  if (!z.uuid().safeParse(fulfillmentId).success) return null;
  const result = await cateringCounts(ctx.viewer.db, fulfillmentId);
  return result.ok ? result.data : null;
}
