import { NextResponse, type NextRequest } from "next/server";
import { docsUrl } from "@/lib/docs-site";
import type { Env } from "@/lib/env";
import { securityHeaders } from "@/lib/security/headers";

/**
 * The API host (RRR-119). With XOS_API_HOST set, for example to api.ghxstship.tech, Atlas answers
 * that host as the public API only, before the proxy does any of its page work:
 *
 * - `/v1/...` is rewritten to `/api/v1/...`, so the same route, authenticator, rate limiter and IP
 *   allow-list serve both hosts. The route strips either prefix (app/api/v1/[...path]/route.ts),
 *   because a rewritten request keeps its original path.
 * - A GET of `/` or `/v1` answers a small JSON pointer to the OpenAPI document and the docs.
 * - `/oauth/authorize`, which the OpenAPI document names relative to the server, goes to Atlas's
 *   own authorize route, where the person signs in and consents (A99, ADR 0055). `/oauth/token`
 *   is outside the proxy's matcher and served by its route handler on either host.
 * - Everything else answers a 404 problem, as the API does for a path or method it does not
 *   serve, so no Atlas page renders there.
 *
 * The session is never read or refreshed on this host and no cookie is set. The Atlas session cookie
 * carries the `__Host-` prefix over https, so browsers never send it to another host. The API sends
 * no CORS headers on either host. The proxy's matcher skips `/api/`, `/_next/`, `/.well-known/` and
 * prefetch requests; on this host those reach only the API itself, static files and the universal
 * link files, which set no cookie either.
 */

/** The prefix the API host serves the API under; Atlas's own host serves it at `/api/v1`. */
export const API_HOST_PREFIX = "/v1";

/** True when the request's Host header names the configured API host (case and port ignored). */
export function isApiHost(host: string | null, config: Pick<Env, "XOS_API_HOST">): boolean {
  if (!config.XOS_API_HOST || !host) return false;
  return host.toLowerCase().replace(/:\d+$/, "") === config.XOS_API_HOST;
}

const PROBLEM = "application/problem+json";

function withHeaders(response: NextResponse, secureSite: boolean): NextResponse {
  for (const [name, value] of Object.entries(securityHeaders(secureSite))) {
    response.headers.set(name, value);
  }
  return response;
}

/** The response for a request on the API host. */
export function apiHostResponse(
  request: NextRequest,
  config: Pick<Env, "ATLAS_SITE_URL" | "DOCS_SITE_URL">,
): NextResponse {
  const secureSite = config.ATLAS_SITE_URL.startsWith("https:");
  const { pathname, search } = request.nextUrl;

  if (pathname.startsWith(`${API_HOST_PREFIX}/`) && pathname !== `${API_HOST_PREFIX}/`) {
    const target = new URL(`/api${pathname}${search}`, request.url);
    return withHeaders(NextResponse.rewrite(target), secureSite);
  }

  if (pathname === "/oauth/authorize") {
    const target = new URL(`/oauth/authorize${search}`, config.ATLAS_SITE_URL);
    return withHeaders(NextResponse.redirect(target), secureSite);
  }

  const method = request.method.toUpperCase();
  const describe =
    (pathname === "/" || pathname === API_HOST_PREFIX || pathname === `${API_HOST_PREFIX}/`) &&
    (method === "GET" || method === "HEAD");
  if (describe) {
    const host = request.headers.get("host") ?? request.nextUrl.host;
    const base = `${request.nextUrl.protocol}//${host}${API_HOST_PREFIX}`;
    const docs = docsUrl(config, "/reference");
    const pointer = NextResponse.json(
      {
        name: "XOS Public API",
        versions: { v1: { base_url: base, openapi: `${base}/openapi.json` } },
        ...(docs ? { docs } : {}),
      },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );
    return withHeaders(pointer, secureSite);
  }

  const missing = NextResponse.json(
    {
      type: "/problems/not-found",
      title: "Not Found",
      status: 404,
      detail: `No operation is served at this path. The API is served under ${API_HOST_PREFIX}.`,
      instance: pathname,
    },
    { status: 404, headers: { "Content-Type": PROBLEM } },
  );
  return withHeaders(missing, secureSite);
}
