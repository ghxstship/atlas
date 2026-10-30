import { clientAddress, trustedProxyHops } from "@xos/data/client-address";
import { supabaseTokenUrl, tokenRequestBody } from "@xos/data/oauth";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { oauthResources } from "@/lib/mcp/connectors";

/**
 * The OAuth 2.1 token endpoint the OpenAPI document names (A99, ADR 0055): the authorization code grant with the PKCE
 * verifier, and the refresh token grant with rotation, both answered by Supabase Auth's OAuth server, which this route
 * forwards to unchanged. Apps call it from their own servers or native code, never with the Atlas session cookie, so
 * the proxy skips it (no CSRF origin check, no cookies). Only form-encoded bodies up to 8 KB are taken; the answer is
 * never cached. The app's address, as clientAddress() reads it behind the trusted proxies, goes on as the one
 * X-Forwarded-For entry, so Supabase Auth's per-address token limits count each app, not Atlas. MCP clients send
 * `resource` (RFC 8707) here too: it is checked as at authorize, one XOS serves, and left out of what Supabase Auth
 * gets (B16, ADR 0155 D1).
 */

export const dynamic = "force-dynamic";

const MAX_BODY = 8 * 1024;

function oauthError(status: number, error: string, description: string): NextResponse {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { "cache-control": "no-store", pragma: "no-cache" } },
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return oauthError(
      400,
      "invalid_request",
      "Send the token request as application/x-www-form-urlencoded.",
    );
  }
  const body = await request.text();
  if (body.length > MAX_BODY) {
    return oauthError(400, "invalid_request", "The token request is too large.");
  }
  const forwarded = tokenRequestBody(body, oauthResources(env()));
  if (!forwarded.ok) {
    return oauthError(400, "invalid_target", "The resource is not one XOS serves.");
  }
  const grant = new URLSearchParams(body).get("grant_type");
  if (grant !== "authorization_code" && grant !== "refresh_token") {
    return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  }
  const caller = clientAddress(request.headers, trustedProxyHops(env().XOS_TRUSTED_PROXY_HOPS));
  const answer = await fetch(supabaseTokenUrl(env().SUPABASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      apikey: env().SUPABASE_ANON_KEY,
      ...(caller ? { "x-forwarded-for": caller } : {}),
    },
    body: forwarded.body,
    cache: "no-store",
  });
  const text = await answer.text();
  return new NextResponse(text, {
    status: answer.status,
    headers: {
      "content-type": answer.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}
