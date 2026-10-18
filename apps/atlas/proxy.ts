import { getCurrentPerson } from "@xos/data";
import { VIEW_AS_COOKIE } from "@xos/data/access";
import { findRoute } from "@xos/ia";
import { NextResponse, type NextRequest } from "next/server";
import { sitemap } from "@/ia/sitemap.generated";
import { env } from "@/lib/env";
import {
  buildCsp,
  createNonce,
  isCrossSiteMutation,
  securityHeaders,
} from "@/lib/security/headers";
import { decideRoute } from "@/lib/shell/guard";
import { LAST_ORG_COOKIE } from "@/lib/shell/last-org";
import { applyViewAs } from "@/lib/access/view-as";
import { resolveMembership } from "@/lib/shell/membership";
import { createProxySupabase } from "@/lib/supabase/proxy";

/**
 * Atlas proxy (Next 16 renames middleware to proxy), run before every page and server action:
 *   1. refuses cross-site state-changing requests (CSRF, Section 9);
 *   2. issues a per-request nonce and the strict Content Security Policy, HSTS and the other
 *      security headers;
 *   3. refreshes the Supabase session so tokens renew silently (Section 11.7);
 *   4. guards routes from the sitemap: signed-out visitors go to sign in, and a route the viewer
 *      may not see renders the 404 page with status 404, never 403 (ADR 0006).
 * Pages repeat the visibility check (components/shell/sitemap-page.tsx), so a matcher change can
 * never open a hidden page.
 */

/** A path no route serves; rewriting to it renders app/not-found.tsx with status 404. */
const NOT_FOUND_PATH = "/auth/not-found";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const config = env();
  const development = config.NODE_ENV === "development";
  const secureSite = config.ATLAS_SITE_URL.startsWith("https:");
  if (
    isCrossSiteMutation({
      method: request.method,
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
      siteOrigin: config.ATLAS_SITE_URL,
    })
  ) {
    return new NextResponse(null, { status: 403 });
  }

  const nonce = createNonce();
  const csp = buildCsp({
    nonce,
    development,
    supabaseOrigin: new URL(config.SUPABASE_URL).origin,
    secureSite,
  });
  /** Request headers for the app, rebuilt after any cookie refresh so they carry the new cookies. */
  const forwardedHeaders = () => {
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("content-security-policy", csp);
    return headers;
  };
  const secure = <T extends NextResponse>(response: T): T => {
    response.headers.set("Content-Security-Policy", csp);
    for (const [name, value] of Object.entries(securityHeaders(secureSite))) {
      response.headers.set(name, value);
    }
    return response;
  };

  const { db, response } = createProxySupabase(request, () =>
    NextResponse.next({ request: { headers: forwardedHeaders() } }),
  );
  const { data } = await db.auth.getUser();
  const user = data.user;

  let personId: string | null | undefined;
  const decision = await decideRoute(sitemap, {
    path: request.nextUrl.pathname,
    search: request.nextUrl.search,
    signedIn: user !== null,
    navFor: async (slug) => {
      if (!user) return null;
      if (personId === undefined) {
        const person = await getCurrentPerson(db, user.id);
        personId = person.ok ? person.data.id : null;
      }
      if (personId === null) return null;
      const membership = await resolveMembership(db, personId, slug, request.headers);
      if (!membership) return null;
      // View as role (A36): a preview guards routes as the previewed role, as pages do.
      const previewed = await applyViewAs(
        db,
        membership,
        request.cookies.get(VIEW_AS_COOKIE)?.value,
      );
      return previewed.nav;
    },
  });

  if (decision.kind === "redirect") {
    const redirect = NextResponse.redirect(new URL(decision.to, request.url));
    for (const cookie of response().cookies.getAll()) redirect.cookies.set(cookie);
    return secure(redirect);
  }
  if (decision.kind === "not-found") {
    const rewrite = NextResponse.rewrite(new URL(NOT_FOUND_PATH, request.url), {
      request: { headers: forwardedHeaders() },
    });
    for (const cookie of response().cookies.getAll()) rewrite.cookies.set(cookie);
    return secure(rewrite);
  }
  const result = response();
  // Remember the org this device opened last, so the entry route returns to it.
  const slug = findRoute(sitemap, request.nextUrl.pathname)?.params["org"];
  if (slug && user && request.cookies.get(LAST_ORG_COOKIE)?.value !== slug) {
    result.cookies.set(LAST_ORG_COOKIE, slug, {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: secureSite,
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return secure(result);
}

export const config = {
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|favicon.ico|\\.well-known/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
