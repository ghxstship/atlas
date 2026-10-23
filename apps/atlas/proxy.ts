import { getCurrentPerson } from "@xos/data";
import { touchMySession } from "@xos/data/account-security";
import { requestDevice } from "@xos/data/session-device";
import { VIEW_AS_COOKIE } from "@xos/data/access";
import {
  CONSENT_COOKIE,
  consentCookieOptions,
  newVisitorId,
  parseConsent,
  preferenceCookieOptions,
  preferencesAllowed,
  recordCookieConsent,
  sendsGpc,
  serializeConsent,
} from "@xos/data/consent";
import { tokenAal, type OrgAuthDecision } from "@xos/data/auth-assurance";
import { findRoute, getNode } from "@xos/ia";
import { OFFLINE_KEY_HEADER, offlineKey } from "@xos/ui/pwa/offline-key";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { sitemap } from "@/ia/sitemap.generated";
import {
  LAST_SEEN_COOKIE,
  lastSeenSetCookie,
  recordsLastSeen,
  opensWithoutSecondFactor,
  orgAuthRedirect,
  parseLastSeen,
  PATH_HEADER,
  secondFactorRedirect,
} from "@/lib/auth/assurance";
import { apiHostResponse, isApiHost } from "@/lib/api-host";
import { env } from "@/lib/env";
import {
  buildCsp,
  createNonce,
  isCrossSiteMutation,
  securityHeaders,
} from "@/lib/security/headers";
import { decideRoute } from "@/lib/shell/guard";
import { LAST_ORG_COOKIE } from "@/lib/shell/last-org";
import { ROUTE_ORG_HEADER } from "@/lib/shell/route-org";
import { applyViewAs } from "@/lib/access/view-as";
import { resolveMembership } from "@/lib/shell/membership";
import { createProxySupabase } from "@/lib/supabase/proxy";

/**
 * Atlas proxy (Next 16 renames middleware to proxy), run before every page and server action:
 *   0. on the API host (XOS_API_HOST), answers as the public API and does nothing below;
 *   1. refuses cross-site state-changing requests (CSRF, Section 9);
 *   2. issues a per-request nonce and the strict Content Security Policy, HSTS and the other
 *      security headers;
 *   3. refreshes the Supabase session so tokens renew silently (Section 11.7);
 *   4. guards routes from the sitemap: signed-out visitors go to sign in, and a route the viewer
 *      may not see renders the 404 page with status 404, never 403 (ADR 0006);
 *   5. records a Global Privacy Control signal once per browser (Section 14.3, A65-014): the
 *      signal refuses every non-essential cookie, is logged server-side and stands in for the
 *      banner's choice.
 *   6. asks for the second factor (A77, Section 9): a person who holds one verifies it after the
 *      first factor, and an org's security.mfa_policy, security.session_hours and
 *      security.idle_timeout_minutes send the person to verify or sign in again before its pages
 *      (lib/auth/assurance.ts, orgAuthRedirect);
 *   6. records the device behind the session at most once a minute, for Personal settings, Security
 *      (A99, migration 1561): the client address as clientAddress() reads it, the place the host
 *      derived from it, and the user agent.
 * Pages repeat the visibility check (components/shell/sitemap-page.tsx), so a matcher change can
 * never open a hidden page.
 *
 * Every request it runs on gets the route's org in ROUTE_ORG_HEADER, or loses a value the client sent
 * (lib/shell/route-org.ts). A prefetch, which renders a page ahead of the navigation, gets only that:
 * no nonce, session refresh, guard or cookie, as when prefetches skipped the proxy entirely.
 */

/** A prefetch the router (next/link) or the browser makes ahead of a navigation. */
function isPrefetch(request: NextRequest): boolean {
  return (
    request.headers.has("next-router-prefetch") || request.headers.get("purpose") === "prefetch"
  );
}

/** The request's headers with ROUTE_ORG_HEADER set to the route's org, or removed when it names none. */
function withRouteOrg(request: NextRequest, slug: string | undefined): Headers {
  const headers = new Headers(request.headers);
  if (slug) headers.set(ROUTE_ORG_HEADER, slug);
  else headers.delete(ROUTE_ORG_HEADER);
  return headers;
}

/** A path no route serves; rewriting to it renders app/not-found.tsx with status 404. */
const NOT_FOUND_PATH = "/auth/not-found";
/** Where a member whose network an org's IP allow-list refuses is sent. */
const NETWORK_RESTRICTED_PATH = "/auth/network-restricted";

/** A top-level page load, not a server action, an RSC fetch or a prefetch. */
function isDocumentRequest(request: NextRequest): boolean {
  if (
    request.method !== "GET" ||
    request.headers.has("rsc") ||
    request.headers.has("next-action")
  ) {
    return false;
  }
  const dest = request.headers.get("sec-fetch-dest");
  return dest === null
    ? (request.headers.get("accept") ?? "").includes("text/html")
    : dest === "document";
}

export async function proxy(request: NextRequest, event?: NextFetchEvent): Promise<NextResponse> {
  const config = env();
  // The API host (XOS_API_HOST) serves the public API only: no CSRF page check, session refresh,
  // route guard or cookie applies there (lib/api-host.ts).
  if (isApiHost(request.headers.get("host"), config)) return apiHostResponse(request, config);
  // The org the route names, for the server code that renders before the page has its params.
  const slug = findRoute(sitemap, request.nextUrl.pathname)?.params["org"];
  // A prefetched page negotiates its locale as the page will (i18n/request.ts), and nothing else runs.
  if (isPrefetch(request)) {
    return NextResponse.next({ request: { headers: withRouteOrg(request, slug) } });
  }
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
    const headers = withRouteOrg(request, slug);
    headers.set("x-nonce", nonce);
    headers.set("content-security-policy", csp);
    headers.set(PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return headers;
  };
  // Global Privacy Control (Section 14.3): a browser that sends it and has no recorded GPC choice yet.
  const consent = parseConsent(request.cookies.get(CONSENT_COOKIE)?.value);
  const gpc = sendsGpc(request.headers);
  const gpcConsent =
    gpc && consent?.gpc !== true && isDocumentRequest(request)
      ? {
          visitorId: consent?.visitorId ?? newVisitorId(),
          preferences: false,
          performance: false,
          gpc: true,
        }
      : null;
  const secure = <T extends NextResponse>(response: T): T => {
    if (gpcConsent) {
      response.cookies.set(
        CONSENT_COOKIE,
        serializeConsent(gpcConsent),
        consentCookieOptions(secureSite),
      );
    }
    response.headers.set("Content-Security-Policy", csp);
    for (const [name, value] of Object.entries(securityHeaders(secureSite))) {
      response.headers.set(name, value);
    }
    return response;
  };

  // The org idle timeout judges the device's previous request, recorded at most once a minute
  // (recordsLastSeen); pages and actions behind this request see it recorded already.
  const now = Date.now();
  const lastSeenAt = parseLastSeen(request.cookies.get(LAST_SEEN_COOKIE)?.value);
  const recordSeen = recordsLastSeen(lastSeenAt, now);
  if (recordSeen) request.cookies.set(LAST_SEEN_COOKIE, String(now));

  const { db, response } = createProxySupabase(request, () =>
    NextResponse.next({ request: { headers: forwardedHeaders() } }),
  );
  const { data } = await db.auth.getUser();
  const user = data.user;
  if (gpcConsent) {
    const recorded = await recordCookieConsent(db, gpcConsent);
    if (!recorded.ok) console.error("Global Privacy Control was not recorded", recorded.error);
  }
  const path = request.nextUrl.pathname;
  const carry = (target: NextResponse) => {
    for (const cookie of response().cookies.getAll()) target.cookies.set(cookie);
    return secure(target);
  };

  // A person who holds a verified second factor verifies it before anything that needs a session.
  if (user && !opensWithoutSecondFactor(path)) {
    const route = findRoute(sitemap, path);
    const auth = route ? (getNode(sitemap, route.id).node.auth ?? "session") : "session";
    const holdsFactor = (user.factors ?? []).some((f) => f.status === "verified");
    if (auth === "session" && holdsFactor) {
      const { data: current } = await db.auth.getSession();
      if (tokenAal(current.session?.access_token) === "aal1") {
        const to = secondFactorRedirect(path, request.nextUrl.search);
        return carry(NextResponse.redirect(new URL(to, request.url)));
      }
    }
  }

  let personId: string | null | undefined;
  const network: { restrictedOrg: string | null } = { restrictedOrg: null };
  const owed: { org: string | null; decision: OrgAuthDecision } = { org: null, decision: "ok" };
  const decision = await decideRoute(sitemap, {
    path,
    search: request.nextUrl.search,
    signedIn: user !== null,
    navFor: async (slug) => {
      if (!user) return null;
      if (personId === undefined) {
        const person = await getCurrentPerson(db, user.id);
        personId = person.ok ? person.data.id : null;
      }
      if (personId === null) return null;
      const membership = await resolveMembership(
        db,
        personId,
        slug,
        request.headers,
        () => {
          network.restrictedOrg = slug;
        },
        {
          lastSeenAt,
          onRequired: (reason) => {
            owed.org = slug;
            owed.decision = reason;
          },
        },
      );
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
  if (decision.kind === "not-found" && network.restrictedOrg !== null) {
    // The org's IP allow-list refused this network (migration 1201): say so, and let an Owner take
    // emergency access, instead of a 404.
    const restricted = NextResponse.redirect(
      new URL(
        `${NETWORK_RESTRICTED_PATH}?org=${encodeURIComponent(network.restrictedOrg)}`,
        request.url,
      ),
    );
    for (const cookie of response().cookies.getAll()) restricted.cookies.set(cookie);
    return secure(restricted);
  }
  if (decision.kind === "not-found" && owed.org !== null) {
    // The org's security settings ask more of this session (migration 1330): verify a second
    // factor, or sign in again after its session lifetime or idle timeout.
    const to = orgAuthRedirect(owed.decision, owed.org, path, request.nextUrl.search);
    if (to !== null) return carry(NextResponse.redirect(new URL(to, request.url)));
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
  if (slug && user && request.cookies.get(LAST_ORG_COOKIE)?.value !== slug) {
    // A Preferences cookie (legal/cookie-policy.md): 12 months with consent, the visit without it.
    result.cookies.set(
      LAST_ORG_COOKIE,
      slug,
      preferenceCookieOptions(preferencesAllowed(consent, gpc), secureSite),
    );
  }
  if (user && recordSeen) {
    // The device's last request, for the org idle timeout (security.idle_timeout_minutes). Last,
    // because response.cookies rewrites every Set-Cookie header from its own list when it sets one.
    result.headers.append("set-cookie", lastSeenSetCookie(now, secureSite));
    // The same minute records the session's device for Security (A99), after the response.
    const touched = touchMySession(db, {
      surface: "Atlas",
      ...requestDevice(request.headers, {
        VERCEL: process.env["VERCEL"],
        XOS_TRUSTED_PROXY_HOPS: config.XOS_TRUSTED_PROXY_HOPS,
      }),
    }).then((outcome) => {
      if (!outcome.ok) console.error("session device not recorded", outcome.error);
    });
    if (event) event.waitUntil(touched);
    else await touched;
  }
  // The service worker keeps a page for offline reading only under the person it was served to (A96).
  if (user) result.headers.set(OFFLINE_KEY_HEADER, await offlineKey(user.id));
  return secure(result);
}

/**
 * Every page request, prefetches included (they take the light path above). The proxy never sees the
 * /api/ route handlers, the calendar feeds, the OAuth token endpoint or static files, and none of them
 * negotiates a locale.
 */
export const config = {
  matcher: [
    {
      // Calendar feeds (/ical/{token}.ics, ADR 0040) answer without a session: no cookie is read,
      // refreshed or set for them, and calendar apps get no page headers.
      // The OAuth token endpoint (A99) is called by apps, never with the session cookie, so no CSRF
      // origin check or cookie applies to it either.
      source: "/((?!api/|ical/|oauth/token|_next/static|_next/image|favicon.ico|\\.well-known/).*)",
    },
  ],
};
