import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Change tracking (B6, ADR 0145): what changed since a person last looked, or was last told. The
 * diff always comes from the audit ledger (migrations 2950 and 2951), compared with one instant per
 * person, and is never stored:
 *   * seen marks keep when a person last looked at Today, an engagement's itinerary or a project's
 *     Show day. A visit is a 30-minute window, so a refresh never clears the highlights;
 *   * communication marks keep when a coordinator told the person on a shift about it.
 * Every function names fields, never values.
 */

/** A page whose changes are marked since the person last looked (app.seen_surface). */
export type SeenSurface = "Today" | "Itinerary" | "Show Day";

export type ChangeKind = "added" | "changed" | "removed";

/** The most ids app.changes_since takes in one call. */
export const CHANGES_SINCE_CHUNK = 200;

/** The most ids app.communication_status and app.mark_communicated take in one call. */
export const COMMUNICATION_CHUNK = 500;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toChangeKind(value: string | null | undefined): ChangeKind {
  return value === "added" || value === "removed" ? value : "changed";
}

/**
 * The instant the person's page compares against, without recording a visit: what the visit will
 * commit. Null on a first visit.
 */
export async function seenBaseline(
  db: XosClient,
  surface: SeenSurface,
  scopeId: string,
): Promise<Result<string | null>> {
  const { data, error } = await db.rpc("seen_baseline", {
    p_surface: surface,
    p_scope_id: scopeId,
  });
  if (error) return fail(toDataError(error));
  return ok((data as string | null) ?? null);
}

/** Records that the person opened the page; returns the baseline in effect (null on a first visit). */
export async function recordVisit(
  db: XosClient,
  surface: SeenSurface,
  scopeId: string,
): Promise<Result<string | null>> {
  const { data, error } = await db.rpc("record_visit", { p_surface: surface, p_scope_id: scopeId });
  if (error) return fail(toDataError(error));
  return ok((data as string | null) ?? null);
}

/** Mark all as seen: moves the baseline to now and returns it. */
export async function markSeen(
  db: XosClient,
  surface: SeenSurface,
  scopeId: string,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("mark_seen", { p_surface: surface, p_scope_id: scopeId });
  if (error) return fail(toDataError(error));
  return ok(data as string);
}

export interface RowChange {
  readonly subjectId: string;
  readonly kind: ChangeKind;
  /** The fields that changed: columns, or `attributes.<column>` for a record's kind attributes. */
  readonly fields: readonly string[];
  readonly changedAt: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
}

interface ChangeRow {
  subject_id: string;
  change_kind: string;
  fields: string[] | null;
  changed_at: string;
  actor_person_id: string | null;
  actor_name: string | null;
}

/**
 * What others changed after `since` on rows of a field history subject the caller reads, keyed by
 * row id. Sends the ids 200 at a time; a null baseline returns nothing without a query.
 */
export async function listChangesSince(
  db: XosClient,
  table: string,
  ids: readonly string[],
  since: string | null,
): Promise<Result<Map<string, RowChange>>> {
  const out = new Map<string, RowChange>();
  const unique = [...new Set(ids)];
  if (since === null || unique.length === 0) return ok(out);
  const results = await Promise.all(
    chunks(unique, CHANGES_SINCE_CHUNK).map((part) =>
      db.rpc("changes_since", { p_subject_table: table, p_subject_ids: part, p_since: since }),
    ),
  );
  for (const { data, error } of results) {
    if (error) return fail(toDataError(error));
    for (const row of (data ?? []) as ChangeRow[]) {
      out.set(row.subject_id, {
        subjectId: row.subject_id,
        kind: toChangeKind(row.change_kind),
        fields: row.fields ?? [],
        changedAt: row.changed_at,
        actorId: row.actor_person_id,
        actorName: row.actor_name,
      });
    }
  }
  return ok(out);
}

export interface TodayChange {
  readonly table: "app.records" | "app.shifts";
  readonly subjectId: string;
  /** The record's key (NWL-42); null for a shift. */
  readonly key: string | null;
  readonly title: string | null;
  readonly projectKey: string | null;
  readonly kind: ChangeKind;
  readonly fields: readonly string[];
  readonly changedAt: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
}

interface TodayChangeRow {
  subject_table: string;
  subject_id: string;
  subject_key: string | null;
  title: string | null;
  project_key: string | null;
  change_kind: string;
  fields: string[] | null;
  changed_at: string;
  actor_person_id: string | null;
  actor_name: string | null;
}

/** The Since your last visit tile of Today: newest first, at most `limit` (1 to 50). */
export async function listTodayChanges(
  db: XosClient,
  orgId: string,
  limit = 20,
): Promise<Result<TodayChange[]>> {
  const { data, error } = await db.rpc("today_changes", { p_org_id: orgId, p_limit: limit });
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as TodayChangeRow[]).map((row) => ({
      table: row.subject_table === "app.shifts" ? "app.shifts" : "app.records",
      subjectId: row.subject_id,
      key: row.subject_key,
      title: row.title,
      projectKey: row.project_key,
      kind: toChangeKind(row.change_kind),
      fields: row.fields ?? [],
      changedAt: row.changed_at,
      actorId: row.actor_person_id,
      actorName: row.actor_name,
    })),
  );
}

/** How the person on a row was last told: a coordinator's mark, their own acceptance, or a notification. */
export type ToldVia = "marked" | "accepted" | "notified";

export interface CommunicationStatus {
  readonly subjectId: string;
  readonly personId: string | null;
  readonly personName: string | null;
  readonly toldAt: string | null;
  readonly toldVia: ToldVia | null;
  readonly toldByName: string | null;
  readonly changedAt: string | null;
  /** Communicable fields others changed after the told instant. */
  readonly changedFields: readonly string[];
  readonly needsReview: boolean;
}

interface CommunicationRow {
  subject_id: string;
  person_id: string | null;
  person_name: string | null;
  told_at: string | null;
  told_via: string | null;
  told_by_name: string | null;
  changed_at: string | null;
  changed_fields: string[] | null;
  needs_review: boolean | null;
}

function toToldVia(value: string | null): ToldVia | null {
  return value === "marked" || value === "accepted" || value === "notified" ? value : null;
}

/** Maps app.communication_status rows (2951). */
export function toCommunicationStatus(row: CommunicationRow): CommunicationStatus {
  return {
    subjectId: row.subject_id,
    personId: row.person_id,
    personName: row.person_name,
    toldAt: row.told_at,
    toldVia: toToldVia(row.told_via),
    toldByName: row.told_by_name,
    changedAt: row.changed_at,
    changedFields: row.changed_fields ?? [],
    needsReview: row.needs_review === true,
  };
}

/**
 * Whether the people on shifts were told of their changes, keyed by shift id. Only rows the caller
 * reads and may write come back; the ids go 500 at a time.
 */
export async function listCommunicationStatus(
  db: XosClient,
  ids: readonly string[],
  table = "app.shifts",
): Promise<Result<Map<string, CommunicationStatus>>> {
  const out = new Map<string, CommunicationStatus>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return ok(out);
  const results = await Promise.all(
    chunks(unique, COMMUNICATION_CHUNK).map((part) =>
      db.rpc("communication_status", { p_subject_table: table, p_subject_ids: part }),
    ),
  );
  for (const { data, error } of results) {
    if (error) return fail(toDataError(error));
    for (const row of (data ?? []) as CommunicationRow[])
      out.set(row.subject_id, toCommunicationStatus(row));
  }
  return ok(out);
}

/**
 * Mark as communicated: one mark per row for the person on it now. All or nothing, so at most 500
 * ids in one call; a longer list is refused rather than split, as a partial mark would mislead.
 */
export async function markCommunicated(
  db: XosClient,
  ids: readonly string[],
  note: string | null = null,
  table = "app.shifts",
): Promise<Result<number>> {
  const { data, error } = await db.rpc("mark_communicated", {
    p_subject_table: table,
    p_subject_ids: [...new Set(ids)],
    ...(note && note.trim() !== "" ? { p_note: note.trim() } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok((data as number | null) ?? 0);
}
