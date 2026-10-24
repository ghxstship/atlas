/**
 * Bulk edit and field history handlers (A106, RRR-151; catalog/modules/parts/bulk-edit-and-history.ts). Both run as
 * the caller through the RPCs of migrations 1451 and 1452, so the row functions and the row's own read policies
 * decide. A refusal of the whole call (a duplicate row, a resource that does not change in bulk) is a 422; refusals of
 * single rows come back in the result. A row the caller cannot read has no field history: 404.
 */
import { bulkUpdate, type BulkResource, type BulkRow } from "@xos/data/bulk";
import { getFieldHistory } from "@xos/data/field-history";
import type { RequestContext } from "../../runtime/context.ts";
import { unwrap } from "../support/table.ts";

interface BulkBody {
  readonly rows: readonly object[];
  readonly reason?: string | undefined;
}

/** Previews or applies a bulk change; the answer is the RPC's, field for field. */
export async function bulkEdit(
  context: RequestContext,
  resource: BulkResource,
  body: BulkBody,
  preview: boolean,
) {
  return unwrap(
    await bulkUpdate(context.db, resource, body.rows as readonly BulkRow[], {
      preview,
      reason: body.reason ?? null,
    }),
  );
}

/** The field history of one row, one entry per event, newest first, as a page without a cursor. */
export async function fieldHistory(
  context: RequestContext,
  table: string,
  id: string,
  limit: number | undefined,
) {
  const events = unwrap(await getFieldHistory(context.db, table, id, limit ?? 200));
  return {
    data: events.map((e) => ({
      event_id: e.id,
      changed_at: e.at,
      actor_person_id: e.actorId,
      actor_name: e.actorName,
      operation: e.operation,
      changes: e.changes.map((c) => ({
        field: c.field,
        old_value: c.before,
        new_value: c.after,
        masked: c.masked,
      })),
    })),
    next_cursor: null,
  };
}
