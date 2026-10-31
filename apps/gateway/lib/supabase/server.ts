import { createServerClient } from "@supabase/ssr";
import { createPublicClient } from "@xos/data/client";
import type { Database, XosClient } from "@xos/data/gateway";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { authCookieOptions } from "./cookies";

/**
 * Supabase client for server components, server actions and route handlers, bound to the request
 * cookies. Gateway reads engagement data only through the `api_external` projections (Section 8.7,
 * ADR 0019 item 5); the repository functions in @xos/data switch schema for those reads. Server
 * components cannot write cookies; the proxy refreshes the session before they render, so the
 * write is skipped there and performed by actions and route handlers.
 */
export async function createServerSupabase(): Promise<XosClient> {
  const store = await cookies();
  const config = env();
  return createServerClient<Database, "app">(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    db: { schema: "app" },
    cookieOptions: authCookieOptions(config.GATEWAY_SITE_URL.startsWith("https:")),
    cookies: {
      getAll: () => store.getAll(),
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch (error) {
          // Server components render with read-only cookies. The proxy already refreshed the
          // session for this request, so a write attempted during render is safe to drop.
          if (!(error instanceof Error) || !/Cookies can only be modified/i.test(error.message)) {
            throw error;
          }
        }
      },
    },
  });
}

/**
 * A client with no session, acting as anon, for the advance link's writes (R10): the api_public token
 * RPCs and the upload to the one party-uploads object a ticket opens. A link answer is the link's,
 * whoever happens to be signed in, so its allocations are requested by the person who claims it.
 */
export function createAnonSupabase(): XosClient {
  const config = env();
  return createPublicClient({ url: config.SUPABASE_URL, anonKey: config.SUPABASE_ANON_KEY });
}
