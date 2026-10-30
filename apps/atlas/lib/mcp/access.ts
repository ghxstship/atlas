import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database, XosClient } from "@xos/data";
import { createHash } from "node:crypto";
import { env } from "@/lib/env";

/**
 * The hosted MCP endpoint's gate (B16, ADR 0155 D1): the connected app a bearer token belongs to, read with
 * app.my_oauth_access as the token itself. The answer is cached 30 seconds per token hash; it only gates the endpoint,
 * since every tool call is checked again by the API and the database.
 */

export interface McpAccess {
  readonly oauthAppId: string;
  readonly orgId: string;
  readonly scopes: readonly string[];
}

const ACCESS_TTL_MS = 30_000;
const cache = new Map<string, { readonly access: McpAccess | null; readonly until: number }>();

/** A Supabase client acting as the bearer token. */
export function tokenDb(token: string): XosClient {
  const config = env();
  return createClient<Database, "app">(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    db: { schema: "app" },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  }) as unknown as XosClient;
}

/** The app the token belongs to, with its live grant's groups, or null for any other token. */
export async function mcpAccess(
  db: XosClient,
  token: string,
  options: { readonly now?: number; readonly fresh?: boolean } = {},
): Promise<McpAccess | null> {
  const now = options.now ?? Date.now();
  const key = createHash("sha256").update(token).digest("hex");
  const cached = cache.get(key);
  if (!options.fresh && cached && cached.until > now) return cached.access;
  const { data, error } = await db.rpc("my_oauth_access");
  const row = error ? undefined : data?.[0];
  const access =
    row && Array.isArray(row.scopes) && row.scopes.length > 0
      ? { oauthAppId: row.oauth_app_id, orgId: row.org_id, scopes: row.scopes }
      : null;
  if (cache.size > 1000) cache.clear();
  cache.set(key, { access, until: now + ACCESS_TTL_MS });
  return access;
}

/** Test seam: forgets every cached answer. */
export function forgetMcpAccess(): void {
  cache.clear();
}
