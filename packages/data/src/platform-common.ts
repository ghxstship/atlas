import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Small helpers shared by A36's repositories (partner console, imports, custom objects, access
 * transparency, org lifecycle and Inbox). Rows come back untyped from tables and RPCs newer than the
 * generated database types and are mapped into declared interfaces at each repository's boundary.
 */

export type Raw = Record<string, unknown>;

export async function rows(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
): Promise<Result<Raw[]>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as Raw[] | null) ?? []);
}

export async function rpc<T>(
  db: XosClient,
  fn: string,
  args: Raw,
  map: (data: unknown) => T,
): Promise<Result<T>> {
  const { data, error } = await untyped(db).rpc(fn, args);
  if (error) return fail(toDataError(error));
  return ok(map(data));
}

/** The id of the one row an insert or update returned, or not-found when it returned none. */
export async function writtenId(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
): Promise<Result<string>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : data) as Raw | null;
  if (!row) return fail({ kind: "not-found" });
  return ok(str(row["id"]));
}

export const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
export const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
export const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);
export const bool = (v: unknown): boolean => v === true;
export const list = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);
