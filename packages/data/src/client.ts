import { createClient } from "@supabase/supabase-js";
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

export interface CallerClientOptions {
  /** Supabase API origin. */
  readonly url: string;
  /** The anon (publishable) key. Never the service role key. */
  readonly anonKey: string;
  /** The caller's verified access token (a Supabase session JWT). */
  readonly accessToken: string;
  /** Request-scoped fetch, for tests and tracing. */
  readonly fetch?: typeof fetch;
}

/**
 * A client that acts as the caller for one request (the public API, ADR 0003): every query runs
 * with the caller's JWT, so RLS decides access. It never persists or refreshes the session.
 */
export function createCallerClient(options: CallerClientOptions): XosClient {
  return createClient<Database, "app">(options.url, options.anonKey, {
    db: { schema: APP_SCHEMA },
    global: {
      headers: { Authorization: `Bearer ${options.accessToken}` },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
