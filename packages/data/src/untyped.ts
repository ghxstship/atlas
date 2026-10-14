import type { SupabaseClient } from "@supabase/supabase-js";
import type { XosClient } from "./client";

/**
 * The client without generated row types, for two cases only: the record kind extension tables,
 * whose name is computed from the kind (record_build for Build), and tables and RPCs added in
 * migrations newer than the generated database types. Callers map every row into a declared
 * interface at the boundary, so nothing untyped leaves the repository.
 */
export function untyped(db: XosClient): SupabaseClient {
  return db as unknown as SupabaseClient;
}
