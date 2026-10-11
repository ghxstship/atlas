import { createServerClient } from "@supabase/ssr";
import type { Database, XosClient } from "@xos/data";
import type { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { authCookieOptions } from "./cookies";

/**
 * Supabase client for the proxy (Section 11.7: tokens refresh silently). Reads the request cookies
 * and writes refreshed ones to both the forwarded request (so server components see the new
 * session) and the response (so the browser stores it). `response()` returns the response the
 * proxy should build on after the session check, because a refresh replaces it.
 */
export function createProxySupabase(
  request: NextRequest,
  makeResponse: () => NextResponse,
): { db: XosClient; response: () => NextResponse } {
  const config = env();
  let response = makeResponse();
  const db = createServerClient<Database, "app">(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    db: { schema: "app" },
    cookieOptions: authCookieOptions(config.ATLAS_SITE_URL.startsWith("https:")),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(toSet, headers) {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = makeResponse();
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });
  return { db, response: () => response };
}
