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
