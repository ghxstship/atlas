/**
 * Page enrichers for derived read fields (A63, finding A54-002): each reads a sidecar table, view or ledger once
 * for the page's rows with `in`, never once per row, and merges its fields into the rows. Pass them as a table
 * resource's `enrich` option, or call them from a module's own list and read code.
 */
import type { XosClient } from "@xos/data";
import type { Row } from "./table.ts";
import { from, groupBy, keysOf } from "./table.ts";

/** Merges `fill(group)` into each row by its key, `fill([])` when nothing matched. */
export function mergeBy(
  rows: Row[],
  key: string,
  groups: ReadonlyMap<string, Row[]>,
  fill: (group: readonly Row[]) => Row,
): Row[] {
  return rows.map((row) => ({ ...row, ...fill(groups.get(String(row[key])) ?? []) }));
}

/**
 * When and by whom each row last moved to `toState`, from its transition ledger (`<table>` with `fk` naming the
 * row): `{ at, by }` per row id, absent when it never did.
 */
export async function lastTransitionTo(
  db: XosClient,
  table: string,
  fk: string,
  ids: readonly string[],
  toState: string,
): Promise<Map<string, { at: string; by: string | null }>> {
  const out = new Map<string, { at: string; by: string | null }>();
  if (ids.length === 0) return out;
  const groups = await groupBy(
    from(db, table)
      .select(`${fk}, created_at, created_by`)
      .in(fk, ids)
      .eq("to_state", toState)
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
    fk,
  );
  for (const [id, rows] of groups) {
    const last = rows[rows.length - 1] as Row;
    out.set(id, {
      at: String(last["created_at"]),
      by: (last["created_by"] as string | null) ?? null,
    });
  }
  return out;
}

/** Adds the time (`at`) and, when named, the person (`by`) of each row's last move to `toState`. */
export async function withTransition(
  db: XosClient,
  rows: Row[],
  ledger: { table: string; fk: string; toState: string; at: string; by?: string },
): Promise<Row[]> {
  const last = await lastTransitionTo(
    db,
    ledger.table,
    ledger.fk,
    keysOf(rows, "id"),
    ledger.toState,
  );
  return rows.map((row) => {
    const hit = last.get(String(row["id"]));
    return {
      ...row,
      [ledger.at]: hit?.at ?? null,
      ...(ledger.by === undefined ? {} : { [ledger.by]: hit?.by ?? null }),
    };
  });
}

/**
 * Sums a money column over a group, NULL-aware (Section 3.7): null for an empty group or when any member is
 * unpriced, never zero for nothing.
 */
export function sumMinor(group: readonly Row[], column: string): number | null {
  if (group.length === 0) return null;
  let total = 0;
  for (const row of group) {
    const value = row[column];
    if (value === null || value === undefined) return null;
    total += Number(value);
  }
  return total;
}
