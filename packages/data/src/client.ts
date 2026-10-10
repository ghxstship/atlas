import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * The typed Supabase client every repository function takes. The apps create it (Atlas through
 * `@supabase/ssr` with the request cookies) with `db.schema` set to `app`; canon reads switch with
 * `client.schema("xpms")`. Repository functions never create clients and never hold secrets.
 */
export type XosClient = SupabaseClient<Database, "app">;

export type { Database };

/** The schemas the apps read through PostgREST (supabase/config.toml `api.schemas`). */
export const APP_SCHEMA = "app" as const;
