import { CAPABILITY_CODES } from "@xos/schemas/capabilities/codes";
import { env } from "@/lib/env";
import { mcpHosted, mcpUrlFor, requestOrigin } from "@/lib/mcp/connectors";

/**
 * The OAuth discovery documents of the hosted MCP endpoint (B16, ADR 0155 D1). Every URL is built from the
 * requesting host's origin, so the documents agree on either host and without XOS_API_HOST:
 *
 * - Protected-resource metadata (RFC 9728), at /.well-known/oauth-protected-resource and its path-suffixed forms
 *   /mcp and /api/mcp: the MCP URL as the resource, the requesting origin as the authorization server, the capability
 *   groups as scopes, bearer tokens in the header only. 404 while XOS_MCP_HOSTED is off.
 * - Authorization-server metadata (RFC 8414), always served, since it describes /oauth/authorize and /oauth/token
 *   (S10.1-02): authorization code with PKCE S256 only, public clients only, and no registration endpoint, since
 *   dynamic client registration stays off (ADR 0055 decision 15).
 */

/** The capability groups (first segments of the capability codes), sorted: the scopes an app asks for. */
export const CAPABILITY_GROUPS: readonly string[] = [
  ...new Set(CAPABILITY_CODES.map((code) => code.split(".")[0] ?? code)),
].sort();

const HEADERS = {
  "content-type": "application/json",
  "cache-control": "public, max-age=300",
} as const;

export function protectedResourceMetadata(request: Request): Response {
  const config = env();
  if (!mcpHosted(config)) {
    return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
  }
  return new Response(
    JSON.stringify({
      resource: mcpUrlFor(request, config),
      authorization_servers: [requestOrigin(request)],
      scopes_supported: CAPABILITY_GROUPS,
      bearer_methods_supported: ["header"],
      resource_name: "XOS",
    }),
    { status: 200, headers: HEADERS },
  );
}

export function authorizationServerMetadata(request: Request): Response {
  const issuer = requestOrigin(request);
  return new Response(
    JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: CAPABILITY_GROUPS,
    }),
    { status: 200, headers: HEADERS },
  );
}
