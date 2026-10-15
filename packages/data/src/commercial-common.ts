import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";

/**
 * Shared plumbing for the procurement, vendor, knowledge and canon repositories (A16). Every query
 * resolves to a typed Result: database refusals, hidden rows and conflicts come back as DataError,
 * never as a throw, and a write that row level security filtered to zero rows is not-found.
 */

interface Response<T> {
  readonly data: T | null;
  readonly error: DatabaseErrorLike | null;
}

/** Maps every row of a list read. */
export async function readRows<T, U>(
  query: PromiseLike<Response<T[]>>,
  map: (row: T) => U,
): Promise<Result<U[]>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data ?? []).map(map));
}

/** Maps the one row of a maybeSingle read; no row is not-found. */
export async function readOne<D, U>(
  query: PromiseLike<{ readonly data: D; readonly error: DatabaseErrorLike | null }>,
  map: (row: NonNullable<D>) => U,
): Promise<Result<U>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  if (data === null || data === undefined) return fail({ kind: "not-found" });
  return ok(map(data as NonNullable<D>));
}

/** The id an insert returned with `.select("id").single()`. */
export async function insertedId(
  query: PromiseLike<Response<{ id: string }>>,
): Promise<Result<{ id: string }>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok({ id: data.id });
}

/** An update or soft delete that selected the ids it touched; touching none is not-found. */
export async function touched(
  query: PromiseLike<Response<{ id: string }[]>>,
): Promise<Result<null>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return (data ?? []).length > 0 ? ok(null) : fail({ kind: "not-found" });
}

/** The value an RPC returned. */
export async function rpcValue<D>(
  query: PromiseLike<{ readonly data: D; readonly error: DatabaseErrorLike | null }>,
): Promise<Result<NonNullable<D>>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(data as NonNullable<D>);
}

/** Now as the soft delete stamp. */
export function deletedNow(now: Date = new Date()): { deleted_at: string } {
  return { deleted_at: now.toISOString() };
}

/** Trims text input and turns blank into null. */
export function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A lifecycle move with compare-and-set: the state the person saw, the next one and why. */
export interface Transition<S extends string> {
  readonly id: string;
  readonly expected: S;
  readonly next: S;
  readonly reason: string;
}

/**
 * The states a lifecycle may move to from `from`, read from the shared transition rules
 * (app.lifecycle_transition_rules) so the UI offers exactly what the database accepts.
 */
export function nextStates<S extends string>(
  rules: readonly { readonly from: S; readonly to: S }[],
  from: S,
): S[] {
  return rules.filter((r) => r.from === from).map((r) => r.to);
}

/** The lifecycle ledgers A16 pages show as state history, with their subject column. */
export const STATE_LEDGERS = {
  vendor: ["vendor_state_transitions", "vendor_id"],
  rfq: ["rfq_state_transitions", "rfq_id"],
  purchase_order: ["purchase_order_state_transitions", "purchase_order_id"],
  po_change_order: ["po_change_order_state_transitions", "po_change_order_id"],
  submittal: ["submittal_state_transitions", "submittal_id"],
  sponsor_asset: ["sponsor_asset_state_transitions", "sponsor_asset_id"],
  canon_extension: ["canon_extension_state_transitions", "canon_extension_proposal_id"],
} as const;

export type StateLedger = keyof typeof STATE_LEDGERS;

export interface StateChange {
  readonly id: string;
  /** Null for the creation entry. */
  readonly from: string | null;
  readonly to: string;
  readonly reason: string;
  readonly at: string;
  readonly by: string | null;
}

/** Every state change of one row, oldest first, from its append-only lifecycle ledger. */
export async function listStateHistory(
  db: XosClient,
  ledger: StateLedger,
  subjectId: string,
): Promise<Result<StateChange[]>> {
  const [table, column] = STATE_LEDGERS[ledger];
  const query = (
    db as unknown as {
      from(name: string): {
        select(columns: string): {
          eq(
            column: string,
            value: string,
          ): {
            order(column: string): PromiseLike<{
              data:
                | {
                    id: string;
                    from_state: string | null;
                    to_state: string;
                    reason: string;
                    created_at: string;
                    created_by: string | null;
                  }[]
                | null;
              error: DatabaseErrorLike | null;
            }>;
          };
        };
      };
    }
  )
    .from(table)
    .select("id, from_state, to_state, reason, created_at, created_by")
    .eq(column, subjectId)
    .order("created_at");
  return readRows(query, (row) => ({
    id: row.id,
    from: row.from_state,
    to: row.to_state,
    reason: row.reason,
    at: row.created_at,
    by: row.created_by,
  }));
}
