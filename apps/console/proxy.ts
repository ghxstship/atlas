import { findRoute } from "@xos/ia";
import { NextResponse, type NextRequest } from "next/server";
import { sitemap } from "@/ia/sitemap.generated";
import { env, secureSite } from "@/lib/env";
import {
  buildCsp,
  createNonce,
  isCrossSiteMutation,
  securityHeaders,
} from "@/lib/security/headers";
import { createProxySupabase } from "@/lib/supabase/proxy";

/**
 * Console proxy, run before every page and server action:
 *   1. refuses cross-site state-changing requests (CSRF, Section 9);
 *   2. issues a per-request nonce, the strict Content Security Policy and the security headers, and keeps search
 *      engines out (the console is internal);
 *   3. refreshes the Supabase session so tokens renew silently;
 *   4. sends a signed-out visitor of any sitemap route to sign in.
 * The console layout then requires a live operator and a second factor (lib/operator.ts), and every console RPC
 * checks both again in the database.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const config = env();
  const secure = secureSite(config);
  if (
    isCrossSiteMutation({
      method: request.method,
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
      siteOrigin: config.CONSOLE_SITE_URL,
    })
  ) {
    return new NextResponse(null, { status: 403 });
  }

  const nonce = createNonce();
  const csp = buildCsp({
    nonce,
    development: config.NODE_ENV === "development",
    supabaseOrigin: new URL(config.SUPABASE_URL).origin,
    secureSite: secure,
  });
  const path = request.nextUrl.pathname;
  const forwardedHeaders = () => {
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("x-console-path", `${path}${request.nextUrl.search}`);
    headers.set("content-security-policy", csp);
    return headers;
  };
  const harden = <T extends NextResponse>(response: T): T => {
    response.headers.set("Content-Security-Policy", csp);
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    // Ask Chromium browsers for the color scheme so the System theme renders without a flash.
    response.headers.set("Accept-CH", "Sec-CH-Prefers-Color-Scheme");
    response.headers.set("Vary", "Sec-CH-Prefers-Color-Scheme");
    for (const [name, value] of Object.entries(securityHeaders(secure))) {
      response.headers.set(name, value);
    }
    return response;
  };

  const { db, response } = createProxySupabase(request, () =>
    NextResponse.next({ request: { headers: forwardedHeaders() } }),
  );
  const { data } = await db.auth.getUser();
  if (!data.user && (path === "/" || findRoute(sitemap, path))) {
    const to = new URL(
      `/auth/sign-in?next=${encodeURIComponent(`${path}${request.nextUrl.search}`)}`,
      request.url,
    );
    const redirect = NextResponse.redirect(to);
    for (const cookie of response().cookies.getAll()) redirect.cookies.set(cookie);
    return harden(redirect);
  }
  return harden(response());
}

export const config = {
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
