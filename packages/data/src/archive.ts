import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Archive (Section 4.10, A124): records of every kind (a punch item through its Task record),
 * custom object records, vendors, venues, documents and work orders keep `archived_at`. An archived
 * row stays readable; the list loaders leave it out unless the view's query asks for it with
 * `archived=include` (every row) or `archived=only` (the archived rows). Archiving and unarchiving go
 * through app.archive_row and app.unarchive_row (migration 2180), which check the capability that
 * edits the row and write the audit event.
 */

/** Which rows a list shows: live ones (the default), every one, or the archived ones only. */
export type ArchivedFilter = "exclude" | "include" | "only";

/** The `archived` query parameter values a view may carry; anything else is the default. */
export const ARCHIVED_PARAM_VALUES = ["include", "only"] as const;

export type ArchivableEntity =
  | "records"
  | "punch_items"
  | "work_orders"
  | "custom_object_records"
  | "vendors"
  | "venues"
  | "documents";

/** The filter a query parameter names; a missing or unknown value leaves archived rows out. */
export function parseArchived(value: string | null | undefined): ArchivedFilter {
  return value === "include" || value === "only" ? value : "exclude";
}

/** Narrows a list query by `archived_at`, the way PostgREST builders chain. */
export function applyArchived<Q extends ArchivedQuery<Q>>(
  query: Q,
  filter: ArchivedFilter = "exclude",
): Q {
  if (filter === "include") return query;
  return filter === "only" ? query.not("archived_at", "is", null) : query.is("archived_at", null);
}

interface ArchivedQuery<Q> {
  is(column: string, value: null): Q;
  not(column: string, operator: string, value: null): Q;
}

/** Whether a row with this `archived_at` belongs in a list with this filter. */
export function inArchived(filter: ArchivedFilter, archivedAt: string | null): boolean {
  if (filter === "include") return true;
  return (filter === "only") === (archivedAt !== null);
}

/**
 * Archives or unarchives one row. Answers when it was archived (null once unarchived). Refusals come
 * back typed: a row the caller cannot see (the refusal `archive_row_not_found`) or may read but not
 * edit (42501) is not-found (ADR 0003), and unarchiving a venue whose name a live venue took is the
 * refusal `archive_name_taken`.
 */
export async function setArchived(
  db: XosClient,
  entity: ArchivableEntity,
  id: string,
  archived: boolean,
): Promise<Result<{ archivedAt: string | null }>> {
  const { data, error } = await db.rpc(archived ? "archive_row" : "unarchive_row", {
    p_entity: entity,
    p_id: id,
  });
  if (error) {
    const failure = toDataError(error);
    return fail(
      failure.kind === "refusal" && failure.rule === "archive_row_not_found"
        ? { kind: "not-found" }
        : failure,
    );
  }
  return ok({ archivedAt: (data as string | null) ?? null });
}
