import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Saves of one row against the version the person edited (Section 11.7, ADR 0077), for edits that write a table
 * directly under its row level security: a record's properties and its kind's attributes. The rule is the bulk
 * RPCs' (migration 1770): a save carrying the row's updated_at commits; when someone saved since, only a field both
 * people changed is a conflict, and the conflict answers the row's values now, so the page shows theirs beside
 * mine. Every write is compare-and-set on updated_at, so nothing saved in between is ever overwritten silently.
 */

export type FieldValue = string | number | boolean | null;
export type FieldValues = Readonly<Record<string, FieldValue>>;

export interface VersionedSave {
  /** The values to write, by column. */
  readonly set: FieldValues;
  /** The values the person started from, by column; a field that no longer holds its value is a conflict. */
  readonly expect?: FieldValues;
  /** The row's updated_at as the person loaded it; omitted, only the expected fields are checked. */
  readonly version?: string | null;
}

export type VersionedOutcome =
  | {
      readonly saved: true;
      /** The row's version after the save. */
      readonly version: string;
    }
  | {
      readonly saved: false;
      /** The row now, for the fields the save set or expected, and its version. */
      readonly current: FieldValues;
      readonly version: string;
    };

/** Two field values are the same: equal, both unset, or two spellings of one instant. */
export function sameFieldValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if ((a ?? null) === (b ?? null)) return true;
  if (typeof a === "string" && typeof b === "string") {
    const instant = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
    if (instant.test(a) && instant.test(b)) {
      const x = Date.parse(a);
      const y = Date.parse(b);
      return !Number.isNaN(x) && x === y;
    }
  }
  if (typeof a === "number" && typeof b === "string") return a === Number(b);
  if (typeof a === "string" && typeof b === "number") return Number(a) === b;
  return false;
}

/** Writes are retried this often when other saves keep landing between the check and the write. */
const ATTEMPTS = 3;

/**
 * Saves one row of `table` matched by `match` (its id or record_id) against a version. The outcome is saved with
 * the new version, or a conflict with the row's current values; a row that is gone or hidden is not-found.
 */
export async function saveVersioned(
  db: XosClient,
  table: string,
  match: { readonly column: string; readonly value: string },
  save: VersionedSave,
): Promise<Result<VersionedOutcome>> {
  const client = untyped(db);
  const keys = [...new Set([...Object.keys(save.set), ...Object.keys(save.expect ?? {})])];
  const columns = [...new Set([...keys, "updated_at"])].join(", ");
  const write = async (version: string) => {
    const { data, error } = await client
      .from(table)
      .update(save.set)
      .eq(match.column, match.value)
      .eq("updated_at", version)
      .select("updated_at");
    if (error) return fail<string | null>(toDataError(error));
    const row = (data as { updated_at: string }[] | null)?.[0];
    return ok(row ? row.updated_at : null);
  };

  if (save.version) {
    const first = await write(save.version);
    if (!first.ok) return first;
    if (first.data !== null) return ok({ saved: true, version: first.data });
  }
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .eq(match.column, match.value)
      .maybeSingle();
    if (error) return fail(toDataError(error));
    if (!data) return fail({ kind: "not-found" });
    const row = data as unknown as Record<string, FieldValue>;
    const version = String(row["updated_at"]);
    const current = Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
    // Only the version was sent: any later save is a conflict, as in the bulk RPCs.
    const expected = save.expect ?? {};
    const conflict =
      Object.keys(expected).length === 0
        ? Boolean(save.version)
        : Object.entries(expected).some(([k, v]) => !sameFieldValue(row[k], v));
    if (conflict) return ok({ saved: false, current, version });
    const again = await write(version);
    if (!again.ok) return again;
    if (again.data !== null) return ok({ saved: true, version: again.data });
  }
  // Someone kept saving between every check and write: report the latest as a conflict.
  const { data, error } = await client
    .from(table)
    .select(columns)
    .eq(match.column, match.value)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const row = data as unknown as Record<string, FieldValue>;
  return ok({
    saved: false,
    current: Object.fromEntries(keys.map((k) => [k, row[k] ?? null])),
    version: String(row["updated_at"]),
  });
}
