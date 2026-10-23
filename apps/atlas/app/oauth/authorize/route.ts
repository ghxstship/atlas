import {
  parseAuthorizeRequest,
  readAuthorizeAnswer,
  recordOAuthRequest,
  supabaseAuthorizeUrl,
} from "@xos/data/oauth";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { securityHeaders } from "@/lib/security/headers";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * The OAuth 2.1 authorization endpoint the OpenAPI document names (A99, ADR 0055; Section 10.1). An app sends the
 * person here with its client_id, redirect URI, PKCE challenge (S256 only) and the capability groups it wants in
 * `scope`. The person signs in first if they need to; then Atlas starts Supabase Auth's authorization with Supabase
 * Auth's own scope, records the groups for that authorization (app.record_oauth_request) and opens the consent page.
 * A request that is malformed, or that names an unknown client or redirect URI, is answered here and never redirected,
 * so it cannot be used to bounce a person to an arbitrary address (RFC 6749 section 4.1.2.1).
 */

export const dynamic = "force-dynamic";

function problem(status: number, detail: string): NextResponse {
  const response = new NextResponse(detail, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
  for (const [name, value] of Object.entries(
    securityHeaders(env().ATLAS_SITE_URL.startsWith("https:")),
  )) {
    response.headers.set(name, value);
  }
  return response;
}

/** A relative redirect: Next names a loopback host localhost in request.url (ADR 0036). */
function redirectTo(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { location, "cache-control": "no-store" },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const search = request.nextUrl.searchParams;
  const parsed = parseAuthorizeRequest(search);
  if (!parsed.ok) {
    return problem(
      400,
      `This authorization request is invalid (${parsed.problem}). XOS needs client_id, redirect_uri, response_type=code, a PKCE code_challenge with code_challenge_method=S256, and capability groups in scope.`,
    );
  }
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  if (!data.user) {
    const here = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    return redirectTo(`/auth/sign-in?next=${encodeURIComponent(here)}`);
  }

  const answer = await fetch(supabaseAuthorizeUrl(env().SUPABASE_URL, parsed.request), {
    redirect: "manual",
    headers: { apikey: env().SUPABASE_ANON_KEY },
    cache: "no-store",
  });
  const read = readAuthorizeAnswer(answer.headers.get("location"));
  if (read.kind === "client") {
    // Supabase Auth checked the client and the redirect URI and answers the app with an OAuth error.
    return redirectTo(read.location);
  }
  if (read.kind === "none") {
    return problem(400, "This app or its redirect URI is not registered with XOS.");
  }
  const recorded = await recordOAuthRequest(db, read.authorizationId, parsed.request.scopes);
  const consent = `/oauth/consent?authorization_id=${read.authorizationId}`;
  if (!recorded.ok) {
    const rule = recorded.error.kind === "refusal" ? recorded.error.rule : "oauth_request_expired";
    return redirectTo(`${consent}&error=${encodeURIComponent(rule)}`);
  }
  return redirectTo(consent);
}
