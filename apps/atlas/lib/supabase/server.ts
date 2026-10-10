import { createServerClient } from "@supabase/ssr";
import type { Database, XosClient } from "@xos/data";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { authCookieOptions } from "./cookies";

/**
 * Supabase client for server components, server actions and route handlers, bound to the request
 * cookies. Server components cannot write cookies; the proxy refreshes the session before they
 * render, so the write is skipped there and performed by actions and route handlers.
 */
export async function createServerSupabase(): Promise<XosClient> {
  const store = await cookies();
  const config = env();
  return createServerClient<Database, "app">(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    db: { schema: "app" },
    cookieOptions: authCookieOptions(config.NODE_ENV === "production"),
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
