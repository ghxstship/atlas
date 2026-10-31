import { toBulkOutcome, type BulkOutcome, type BulkRow } from "./bulk.ts";
import type { XosClient } from "./client.ts";
import type { Json } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Bulk actions on the person's own rows in Gateway (Section 11.7, migration 2160, ADR 0082): the
 * actions a Gateway row offers one at a time, on a selection in one all-or-nothing call through
 * 1451's driver, with the same answer as Atlas's bulk edit (`@xos/data/bulk`). Submitting a
 * timesheet is undone by recalling it; a signature and a withdrawal are final.
 */

export const GATEWAY_BULK_RESOURCES = [
  "my_timesheets",
  "my_engagement_documents",
  "my_applications",
  // R8 (2700): the party side's share of a pool for each selected person on its roster.
  "engaged_allocation_assignments",
] as const;
export type GatewayBulkResource = (typeof GATEWAY_BULK_RESOURCES)[number];

const RPC = {
  my_timesheets: "bulk_update_my_timesheets",
  my_engagement_documents: "bulk_update_my_engagement_documents",
  my_applications: "bulk_update_my_applications",
  engaged_allocation_assignments: "bulk_update_engaged_allocation_assignments",
} as const satisfies Record<GatewayBulkResource, string>;

export function isGatewayBulkResource(value: unknown): value is GatewayBulkResource {
  return (GATEWAY_BULK_RESOURCES as readonly unknown[]).includes(value);
}

/**
 * Runs a Gateway bulk action. With `preview` nothing changes and the outcome says what would. A
 * refusal of the call itself (an empty or oversized selection) comes back as an error; refusals
 * of rows come back in the outcome, each with its rule.
 */
export async function bulkUpdateMine(
  db: XosClient,
  resource: GatewayBulkResource,
  rows: readonly BulkRow[],
  options: { readonly preview?: boolean; readonly reason?: string | null } = {},
): Promise<Result<BulkOutcome>> {
  const { data, error } = await db.rpc(RPC[resource], {
    p_rows: rows as unknown as Json,
    p_preview: options.preview ?? false,
    ...(options.reason ? { p_reason: options.reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(toBulkOutcome(data));
}
