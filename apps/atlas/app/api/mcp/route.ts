/**
 * The hosted MCP endpoint (B16, ADR 0155 D1; Section 10.2): stateless Streamable HTTP (@xos/mcp/http) on Atlas at
 * /api/mcp and on the API host at /mcp (lib/api-host.ts rewrites it here). Off unless XOS_MCP_HOSTED=on.
 *
 * Only an OAuth 2.1 access token of an app registered in the org is taken: a Supabase Auth JWT carrying client_id,
 * checked with app.my_oauth_access as the token itself, cached 30 seconds per token hash. API keys stay on the stdio
 * server (xos-mcp). A missing, foreign or revoked token answers 401 naming the protected-resource metadata, so an MCP
 * client can start the authorization (RFC 9728).
 *
 * Tools call the public API in process (lib/api/in-process.ts) with the same token, forwarding the caller's address,
 * traceparent and x-request-id, so the API's rate limits and the org IP allow-list judge the real caller. Every
 * write tool records a proposal (app.propose_agent_change) the person confirms in Personal settings, Connected apps;
 * the database refuses the app's direct writes too (agent_write_needs_review).
 */
import { fieldsFromBody, proposeAgentChange } from "@xos/data/agent-proposals";
import { observe } from "@xos/infra/observability";
import { ProposalRefusal, createHostedSession } from "@xos/mcp";
import { handleMcpHttp } from "@xos/mcp/http";
import { inProcessFetch } from "@/lib/api/in-process";
import { env } from "@/lib/env";
import { mcpAccess, tokenDb } from "@/lib/mcp/access";
import { mcpAllowedOrigins, mcpHosted, onApiHost, requestOrigin } from "@/lib/mcp/connectors";
import { flushErrors, observability } from "@/lib/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function unauthorized(request: Request): Response {
  const config = env();
  const metadata = `${requestOrigin(request)}/.well-known/oauth-protected-resource${onApiHost(request, config) ? "/mcp" : "/api/mcp"}`;
  return new Response(
    JSON.stringify({
      type: "/problems/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Connect with an OAuth access token of an app registered in your organization.",
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/problem+json",
        "cache-control": "no-store",
        "www-authenticate": `Bearer resource_metadata="${metadata}"`,
      },
    },
  );
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

const handle = observe(
  async (request) => {
    const config = env();
    if (!mcpHosted(config)) {
      return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (request.method.toUpperCase() !== "POST") {
      return new Response(
        "This MCP endpoint takes POST only; it opens no stream and keeps no session.",
        {
          status: 405,
          headers: {
            allow: "POST",
            "cache-control": "no-store",
            "content-type": "text/plain; charset=utf-8",
          },
        },
      );
    }
    const token = bearer(request);
    // An API key or a person's session is not an app token: only a JWT whose access row names an app is taken.
    if (token === null || token.startsWith("xos_")) return unauthorized(request);
    const db = tokenDb(token);
    const access = await mcpAccess(db, token);
    if (access === null) return unauthorized(request);
    const site = config.ATLAS_SITE_URL.replace(/\/$/, "");
    const response = await handleMcpHttp(request, {
      allowedOrigins: mcpAllowedOrigins(config),
      session: (protocolVersion) =>
        createHostedSession({
          baseUrl: `${site}/api/v1`,
          accessToken: token,
          grantScopes: access.scopes,
          protocolVersion,
          fetch: inProcessFetch(request.headers),
          propose: async (spec, input) => {
            const result = await proposeAgentChange(db, {
              operationId: spec.id,
              operationScopes: spec.scopes,
              targetId: input.targetId,
              summary: input.summary,
              path: input.path,
              ifMatch: input.ifMatch,
              fields: fieldsFromBody(input.body),
            });
            if (!result.ok) {
              const error = result.error;
              throw new ProposalRefusal(
                error.kind === "refusal"
                  ? error.rule
                  : error.kind === "not-found"
                    ? "agent_session_required"
                    : "proposal_failed",
                error.kind === "refusal" ? error.message : "The change could not be proposed.",
              );
            }
            return {
              suggestionId: result.data.suggestionId,
              expiresAt: result.data.expiresAt,
              reviewUrl: `${site}/${result.data.orgSlug}/me/connected-apps`,
            };
          },
        }),
    });
    if (response.status >= 500) await flushErrors();
    return response;
  },
  { ...observability, route: "/api/mcp" },
);

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
