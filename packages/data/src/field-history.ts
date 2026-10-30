import type { XosClient } from "./client.ts";
import type { Json } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Field history (Section 4.10, ADR 0044): who changed which field of a row and when, from the audit
 * ledger through app.field_history (migration 1452), one event per row (2061). Only someone who can
 * read the row gets it, and a Restricted field arrives masked, with neither value.
 */

export interface FieldChange {
  readonly field: string;
  /** The stored value before and after, as JSON; null for a masked field. */
  readonly before: Json | null;
  readonly after: Json | null;
  readonly masked: boolean;
}

export interface HistoryEvent {
  readonly id: string;
  readonly at: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly operation: "insert" | "update" | "delete";
  readonly changes: readonly FieldChange[];
}

interface HistoryChangeRow {
  readonly field: string;
  readonly old_value: Json | null;
  readonly new_value: Json | null;
  readonly masked: boolean;
}

interface HistoryEventRow {
  readonly event_id: string;
  readonly changed_at: string;
  readonly actor_person_id: string | null;
  readonly actor_name: string | null;
  readonly operation: string;
  readonly changes: Json;
}

/** Maps the RPC's rows (one per event, newest first, changed fields as a JSON array) to events. */
export function toHistoryEvents(rows: readonly HistoryEventRow[]): HistoryEvent[] {
  return rows.map((row) => ({
    id: row.event_id,
    at: row.changed_at,
    actorId: row.actor_person_id,
    actorName: row.actor_name,
    operation: row.operation === "insert" || row.operation === "delete" ? row.operation : "update",
    changes: (Array.isArray(row.changes) ? (row.changes as unknown as HistoryChangeRow[]) : []).map(
      (c) => ({
        field: c.field,
        before: c.masked ? null : c.old_value,
        after: c.masked ? null : c.new_value,
        masked: c.masked,
      }),
    ),
  }));
}

/**
 * The field history of one row, at most `limit` events (1 to 1,000). app.field_history_events
 * (2061) answers one row per event, so the API's row cap (max_rows, 1,000) never cuts an event
 * short or drops the oldest ones.
 */
export async function getFieldHistory(
  db: XosClient,
  table: string,
  id: string,
  limit = 200,
): Promise<Result<HistoryEvent[]>> {
  const { data, error } = await db.rpc("field_history_events", {
    p_subject_table: table,
    p_subject_id: id,
    p_limit: limit,
  });
  if (error) return fail(toDataError(error));
  return ok(toHistoryEvents(data ?? []));
}
