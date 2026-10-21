import { toDataError, type DatabaseErrorLike, type DataError } from "@xos/data/result";

/**
 * The slice of the Supabase client the integration stores use. Typed structurally so this package
 * does not depend on the generated database types; `asDbClient` adapts a real `SupabaseClient`
 * created with the service role by the worker (Section 9: only the runner holds that key).
 */
export interface DbResponse {
  readonly data: unknown;
  readonly error: DatabaseErrorLike | null;
}

export interface QueryBuilder extends PromiseLike<DbResponse> {
  select(columns?: string): QueryBuilder;
  insert(values: unknown): QueryBuilder;
  update(values: unknown): QueryBuilder;
  upsert(
    values: unknown,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): QueryBuilder;
  eq(column: string, value: unknown): QueryBuilder;
  in(column: string, values: readonly unknown[]): QueryBuilder;
  is(column: string, value: null): QueryBuilder;
  gt(column: string, value: unknown): QueryBuilder;
  gte(column: string, value: unknown): QueryBuilder;
  lte(column: string, value: unknown): QueryBuilder;
  not(column: string, operator: string, value: unknown): QueryBuilder;
  order(column: string, options?: { ascending?: boolean }): QueryBuilder;
  limit(count: number): QueryBuilder;
  maybeSingle(): QueryBuilder;
  single(): QueryBuilder;
}

export interface DbClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<DbResponse>;
  from(relation: string): QueryBuilder;
}

/** Adapts a Supabase client (any schema typing) to the structural client the stores use. */
export function asDbClient(client: { rpc: unknown; from: unknown }): DbClient {
  return client as unknown as DbClient;
}

/** A database outcome the store could not turn into data: a refusal, a missing row or an unexpected error. */
export class StoreError extends Error {
  readonly error: DataError;

  constructor(error: DataError) {
    super(error.kind === "not-found" ? "The row does not exist or is not visible." : error.message);
    this.name = "StoreError";
    this.error = error;
  }
}

/** Returns the data of a response or throws a StoreError naming the database outcome. */
export async function unwrap<T>(response: PromiseLike<DbResponse>): Promise<T> {
  const { data, error } = await response;
  if (error) throw new StoreError(toDataError(error));
  return data as T;
}
