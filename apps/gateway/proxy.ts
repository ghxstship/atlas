import { tokenAal } from "@xos/data/auth-assurance";
import { listMyAccounts, listMyEngagementRoleTypes } from "@xos/data/gateway";
import { findRoute, getNode, isNodeVisible } from "@xos/ia";
import { OFFLINE_KEY_HEADER, offlineKey } from "@xos/ui/pwa/offline-key";
import { NextResponse, type NextRequest } from "next/server";
import { sitemap } from "@/ia/sitemap.generated";
import { secondFactorRedirect } from "@/lib/auth/assurance";
import { env, platformHosts } from "@/lib/env";
import {
  buildCsp,
  createNonce,
  isCrossSiteMutation,
  securityHeaders,
} from "@/lib/security/headers";
import {
  ACTING_COOKIE,
  isDesktopAgent,
  isPlatformHost,
  navContext,
  resolveActing,
  routeNeeds,
} from "@/lib/shell/standing";
import { doesPaidWork } from "@/lib/engagement-state";
import { createProxySupabase } from "@/lib/supabase/proxy";

/**
 * Gateway proxy, run before every page and server action:
 *   1. refuses cross-site state-changing requests (CSRF, Section 9);
 *   2. issues a per-request nonce and the strict Content Security Policy and security headers;
 *   3. refreshes the Supabase session so tokens renew silently (Section 11.7);
 *   4. guards routes from the sitemap: public and token routes are open, signed-out visitors go
 *      to sign in, and a route the person's standing may not see renders 404, never 403.
 * Engagement tabs depend on the engagement's role type, which only the page can read, so the
 * proxy checks the engagement node and the page checks the tab. Pages repeat every check.
 */

const NOT_FOUND_PATH = "/auth/not-found";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const config = env();
  const development = config.NODE_ENV === "development";
  const secureSite = config.GATEWAY_SITE_URL.startsWith("https:");
  const host = request.headers.get("host");
  if (
    isCrossSiteMutation({
      method: request.method,
      origin: request.headers.get("origin"),
      host,
      siteOrigin: config.GATEWAY_SITE_URL,
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
  const forwardedHeaders = () => {
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("x-gateway-path", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    headers.set("content-security-policy", csp);
    return headers;
  };
  const secure = <T extends NextResponse>(response: T): T => {
    response.headers.set("Content-Security-Policy", csp);
    // Ask Chromium browsers for the color scheme so the System theme renders without a flash.
    response.headers.set("Accept-CH", "Sec-CH-Prefers-Color-Scheme");
    response.headers.set("Vary", "Sec-CH-Prefers-Color-Scheme");
    for (const [name, value] of Object.entries(securityHeaders(secureSite))) {
      response.headers.set(name, value);
    }
    return response;
  };
  const carryCookies = (target: NextResponse, source: NextResponse) => {
    for (const cookie of source.cookies.getAll()) target.cookies.set(cookie);
    return target;
  };

  const { db, response } = createProxySupabase(request, () =>
    NextResponse.next({ request: { headers: forwardedHeaders() } }),
  );
  const { data } = await db.auth.getUser();
  const user = data.user;
  const path = request.nextUrl.pathname;
  const match = findRoute(sitemap, path);

  if (match) {
    const node = getNode(sitemap, match.id);
    const auth = node.node.auth ?? "session";
    if (auth === "session") {
      if (!user) {
        const next = `${path}${request.nextUrl.search}`;
        const to = new URL(`/auth/sign-in?next=${encodeURIComponent(next)}`, request.url);
        return secure(carryCookies(NextResponse.redirect(to), response()));
      }
      // A person who holds a verified second factor verifies it before any page (A77, Section 9).
      if ((user.factors ?? []).some((f) => f.status === "verified")) {
        const { data: current } = await db.auth.getSession();
        if (tokenAal(current.session?.access_token) === "aal1") {
          const to = new URL(secondFactorRedirect(path, request.nextUrl.search), request.url);
          return secure(carryCookies(NextResponse.redirect(to), response()));
        }
      }
      const accounts = await listMyAccounts(db);
      if (!accounts.ok)
        throw new Error(`Gateway proxy could not read accounts: ${accounts.error.kind}`);
      const acting = resolveActing(accounts.data, request.cookies.get(ACTING_COOKIE)?.value);
      const container = sitemap.engagementTabs?.container;
      const guarded = node.parent?.node.id === container && container ? container : match.id;
      // Only payout, tax and work-detail routes depend on paid work; read role types just for them.
      const roleTypes = routeNeeds(sitemap, guarded, "paid-work")
        ? await listMyEngagementRoleTypes(db)
        : null;
      const ctx = navContext({
        standing: acting.standing,
        companyAccount: acting.account !== null,
        platformDomain: isPlatformHost(host, platformHosts(config)),
        desktop: isDesktopAgent(request.headers.get("user-agent")),
        paidWork: roleTypes?.ok ? doesPaidWork(roleTypes.data) : true,
      });
      if (!isNodeVisible(sitemap, guarded, ctx)) {
        const rewrite = NextResponse.rewrite(new URL(NOT_FOUND_PATH, request.url), {
          request: { headers: forwardedHeaders() },
        });
        return secure(carryCookies(rewrite, response()));
      }
    }
  }
  const result = response();
  // The service worker keeps a page for offline reading only under the person it was served to (A96).
  if (user) result.headers.set(OFFLINE_KEY_HEADER, await offlineKey(user.id));
  return secure(result);
}

export const config = {
  matcher: [
    {
      // Calendar feeds (/ical/{token}.ics, ADR 0040) answer without a session: no cookie is read,
      // refreshed or set for them, and calendar apps get no page headers.
      source: "/((?!api/|ical/|_next/static|_next/image|favicon.ico|\\.well-known/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
