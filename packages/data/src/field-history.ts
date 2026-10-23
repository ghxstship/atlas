import type { XosClient } from "./client.ts";
import type { Json } from "./database.types.ts";
import { untyped } from "./untyped.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Field history (Section 4.10, ADR 0044): who changed which field of a row and when, from the audit
 * ledger through app.field_history (migration 1452). Only someone who can read the row gets it, and
 * a Restricted field arrives masked, with neither value.
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

interface HistoryRow {
  readonly event_id: string;
  readonly changed_at: string;
  readonly actor_person_id: string | null;
  readonly actor_name: string | null;
  readonly operation: string;
  readonly field: string | null;
  readonly old_value: Json | null;
  readonly new_value: Json | null;
  readonly masked: boolean;
}

/** Groups the RPC's rows (one per changed field, newest first) into events, keeping their order. */
export function toHistoryEvents(rows: readonly HistoryRow[]): HistoryEvent[] {
  const events = new Map<string, { event: HistoryEvent; changes: FieldChange[] }>();
  for (const row of rows) {
    let entry = events.get(row.event_id);
    if (!entry) {
      const changes: FieldChange[] = [];
      const operation =
        row.operation === "insert" || row.operation === "delete" ? row.operation : "update";
      entry = {
        changes,
        event: {
          id: row.event_id,
          at: row.changed_at,
          actorId: row.actor_person_id,
          actorName: row.actor_name,
          operation,
          changes,
        },
      };
      events.set(row.event_id, entry);
    }
    if (row.field !== null) {
      entry.changes.push({
        field: row.field,
        before: row.masked ? null : row.old_value,
        after: row.masked ? null : row.new_value,
        masked: row.masked,
      });
    }
  }
  return [...events.values()].map((e) => e.event);
}

export async function getFieldHistory(
  db: XosClient,
  table: string,
  id: string,
  limit = 200,
): Promise<Result<HistoryEvent[]>> {
  const { data, error } = await untyped(db).rpc("field_history", {
    p_subject_table: table,
    p_subject_id: id,
    p_limit: limit,
  });
  if (error) return fail(toDataError(error));
  return ok(toHistoryEvents((data ?? []) as HistoryRow[]));
}
