import { createServerClient } from "@supabase/ssr";
import type { Database, XosClient } from "@xos/data/client";
import { cookies } from "next/headers";
import { env, secureSite } from "@/lib/env";
import { authCookieOptions } from "./cookies";

/**
 * Supabase client for server components, server actions and route handlers, bound to the request cookies and so to
 * the operator's own session. It never holds the service role: the console RPCs check the operator in the database.
 * Server components cannot write cookies; the proxy refreshes the session before they render, so a write attempted
 * during render is dropped and performed by actions and route handlers.
 */
export async function createServerSupabase(): Promise<XosClient> {
  const store = await cookies();
  const config = env();
  return createServerClient<Database, "app">(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    db: { schema: "app" },
    cookieOptions: authCookieOptions(secureSite(config)),
    cookies: {
      getAll: () => store.getAll(),
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch (error) {
          if (!(error instanceof Error) || !/Cookies can only be modified/i.test(error.message)) {
            throw error;
          }
        }
      },
    },
  });
}
