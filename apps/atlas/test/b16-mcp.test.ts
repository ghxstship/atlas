import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B16 (ADR 0155 D1 and D2): the hosted MCP endpoint, its OAuth discovery documents, the authorize route's connector
 * defaults and resource check, and the token route's resource stripping.
 */

const state = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  access: null as null | { oauthAppId: string; orgId: string; scopes: string[] },
  proposals: [] as unknown[],
  propose: {
    ok: true,
    data: { suggestionId: "s-1", expiresAt: "2026-11-06T12:00:00Z", orgSlug: "northwind-live" },
  } as unknown,
  user: { id: "u-1" } as null | { id: string },
  defaults: [] as string[],
  recorded: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: () => state.env }));
vi.mock("@/lib/observability", () => ({
  observability: {
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    errors: { report: vi.fn() },
  },
  flushErrors: async () => undefined,
}));
vi.mock("@xos/infra/observability", () => ({ observe: (handler: unknown) => handler }));
vi.mock("@/lib/mcp/access", () => ({
  tokenDb: () => ({}),
  mcpAccess: async () => state.access,
}));
vi.mock("@xos/data/agent-proposals", async (original) => ({
  ...((await original()) as object),
  proposeAgentChange: async (_db: unknown, input: unknown) => {
    state.proposals.push(input);
    return state.propose;
  },
}));
vi.mock("@/lib/api/app", () => ({
  apiApp: async () => ({
    fetch: async (request: Request) =>
      new Response(
        JSON.stringify({
          data: { id: "p-1", person_id: "x", forwarded: request.headers.get("x-forwarded-for") },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    rpc: async (name: string, args: unknown) => {
      if (name === "oauth_default_scopes") return { data: state.defaults, error: null };
      if (name === "record_oauth_request") {
        state.recorded.push(args);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

const SITE = "https://atlas.example.test";
const BASE_ENV = {
  ATLAS_SITE_URL: SITE,
  SUPABASE_URL: "http://127.0.0.1:1",
  SUPABASE_ANON_KEY: "anon",
  XOS_API_HOST: "api.example.test",
};

const mcp = await import("@/app/api/mcp/route");
const resource = await import("@/app/.well-known/oauth-protected-resource/route");
const resourceMcp = await import("@/app/.well-known/oauth-protected-resource/mcp/route");
const server = await import("@/app/.well-known/oauth-authorization-server/route");
const authorize = await import("@/app/oauth/authorize/route");
const token = await import("@/app/oauth/token/route");

function rpc(
  body: unknown,
  headers: Record<string, string> = {},
  host = "atlas.example.test",
  path = "/api/mcp",
) {
  return new Request(`https://${host}${path}`, {
    method: "POST",
    headers: {
      host,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.env = { ...BASE_ENV, XOS_MCP_HOSTED: "on" };
  state.access = { oauthAppId: "app-1", orgId: "org-1", scopes: ["projects", "home"] };
  state.proposals = [];
  state.user = { id: "u-1" };
  state.defaults = [];
  state.recorded = [];
});

describe("the hosted MCP endpoint", () => {
  it("answers 404 while XOS_MCP_HOSTED is off", async () => {
    state.env = { ...BASE_ENV };
    const response = await mcp.POST(
      rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer t" }),
    );
    expect(response.status).toBe(404);
    expect(
      (await resource.GET(new Request(`${SITE}/.well-known/oauth-protected-resource`))).status,
    ).toBe(404);
  });

  it("answers 401 with the metadata URL without a token, with an API key, and for a token of no app", async () => {
    const none = await mcp.POST(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/api/mcp"`,
    );
    const key = await mcp.POST(
      rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer xos_live_abc" }),
    );
    expect(key.status).toBe(401);
    state.access = null;
    const revoked = await mcp.POST(
      rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer jwt" }),
    );
    expect(revoked.status).toBe(401);
    const api = await mcp.POST(
      rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, "api.example.test", "/api/mcp"),
    );
    expect(api.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://api.example.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("answers GET and DELETE with 405", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const response = await mcp[method](
        new Request(`${SITE}/api/mcp`, { method, headers: { authorization: "Bearer t" } }),
      );
      expect(response.status).toBe(405);
    }
  });

  it("lists the tools without a session, and records a write as a proposal with the review link", async () => {
    const list = await mcp.POST(
      rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer jwt" }),
    );
    expect(list.status).toBe(200);
    const tools = (
      (await list.json()) as { result: { tools: { name: string }[] } }
    ).result.tools.map((t) => t.name);
    expect(tools).toContain("xos_update");
    expect(tools).toContain("xos_delete");
    const { OPERATIONS } = await import("@ghxstship/xos-sdk");
    state.access = {
      oauthAppId: "app-1",
      orgId: "org-1",
      scopes: [...OPERATIONS["projects.update"].scopes],
    };
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const call = await mcp.POST(
      rpc(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "xos_update",
            arguments: { resource: "projects", id, body: { name: "Encore" }, if_match: 'W/"1"' },
          },
        },
        { authorization: "Bearer jwt" },
      ),
    );
    const result = (
      (await call.json()) as { result: { structuredContent: Record<string, unknown> } }
    ).result;
    expect(result.structuredContent).toEqual({
      proposed: true,
      suggestion_id: "s-1",
      expires_at: "2026-11-06T12:00:00Z",
      review_url: `${SITE}/northwind-live/me/connected-apps`,
    });
    expect(state.proposals[0]).toMatchObject({
      operationId: "projects.update",
      targetId: id,
      path: { id },
      ifMatch: 'W/"1"',
      fields: [{ fieldPath: "name", value: "Encore" }],
    });
  });

  it("answers a database refusal of a proposal as a tool error", async () => {
    const { OPERATIONS } = await import("@ghxstship/xos-sdk");
    state.access = {
      oauthAppId: "app-1",
      orgId: "org-1",
      scopes: [...OPERATIONS["projects.update"].scopes],
    };
    state.propose = {
      ok: false,
      error: { kind: "refusal", rule: "org_read_only", message: "This organization is paused." },
    };
    const call = await mcp.POST(
      rpc(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "xos_update",
            arguments: {
              resource: "projects",
              id: "0f8fad5b-d9cb-469f-a165-70867728950e",
              body: { name: "x" },
              if_match: "e",
            },
          },
        },
        { authorization: "Bearer jwt" },
      ),
    );
    const result = (
      (await call.json()) as {
        result: { isError: boolean; structuredContent: Record<string, unknown> };
      }
    ).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: "org_read_only",
      detail: "This organization is paused.",
    });
    state.propose = {
      ok: true,
      data: { suggestionId: "s-1", expiresAt: "2026-11-06T12:00:00Z", orgSlug: "northwind-live" },
    };
  });
});

describe("OAuth discovery", () => {
  it("serves protected-resource metadata on the requesting host", async () => {
    const atlas = (await (
      await resource.GET(
        new Request(`${SITE}/.well-known/oauth-protected-resource`, {
          headers: { host: "atlas.example.test" },
        }),
      )
    ).json()) as Record<string, unknown>;
    expect(atlas).toMatchObject({
      resource: `${SITE}/api/mcp`,
      authorization_servers: [SITE],
      bearer_methods_supported: ["header"],
    });
    expect(atlas["scopes_supported"]).toContain("projects");
    const api = (await (
      await resourceMcp.GET(
        new Request("https://api.example.test/.well-known/oauth-protected-resource/mcp", {
          headers: { host: "api.example.test" },
        }),
      )
    ).json()) as Record<string, unknown>;
    expect(api["resource"]).toBe("https://api.example.test/mcp");
    expect(api["authorization_servers"]).toEqual(["https://api.example.test"]);
  });

  it("serves authorization-server metadata with S256 only and no registration endpoint, even while MCP is off", async () => {
    state.env = { ...BASE_ENV };
    const meta = (await (
      await server.GET(
        new Request(`${SITE}/.well-known/oauth-authorization-server`, {
          headers: { host: "atlas.example.test" },
        }),
      )
    ).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      issuer: SITE,
      authorization_endpoint: `${SITE}/oauth/authorize`,
      token_endpoint: `${SITE}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    expect(meta).not.toHaveProperty("registration_endpoint");
  });
});

describe("authorize and token with MCP connectors", () => {
  const CLIENT = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const query = (extra: Record<string, string>) =>
    new URLSearchParams({
      client_id: CLIENT,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      response_type: "code",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      ...extra,
    });

  it("refuses a foreign resource before anything is sent on", async () => {
    const { NextRequest } = await import("next/server");
    const response = await authorize.GET(
      new NextRequest(
        `${SITE}/oauth/authorize?${query({ scope: "projects", resource: "https://evil.example.test/mcp" })}`,
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("(resource)");
  });

  it("fills a missing scope from the connector's defaults, and refuses one with none", async () => {
    const { NextRequest } = await import("next/server");
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: `http://127.0.0.1:1/oauth/consent?authorization_id=abcdefghijklmnop12345678`,
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    state.defaults = ["home", "projects"];
    const filled = await authorize.GET(
      new NextRequest(`${SITE}/oauth/authorize?${query({ resource: `${SITE}/api/mcp` })}`),
    );
    expect(filled.status).toBe(303);
    expect(state.recorded[0]).toEqual({
      p_authorization_id: "abcdefghijklmnop12345678",
      p_scopes: ["home", "projects"],
    });
    const forwarded = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(forwarded.searchParams.has("resource")).toBe(false);
    state.defaults = [];
    const none = await authorize.GET(new NextRequest(`${SITE}/oauth/authorize?${query({})}`));
    expect(none.status).toBe(400);
    vi.unstubAllGlobals();
  });

  it("checks a token request's resource and strips it before Supabase Auth", async () => {
    const { NextRequest } = await import("next/server");
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const post = (body: string) =>
      token.POST(
        new NextRequest(`${SITE}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        }),
      );
    const foreign = await post(
      `grant_type=authorization_code&code=c&resource=${encodeURIComponent("https://evil.test")}`,
    );
    expect(foreign.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    const ours = await post(
      `grant_type=authorization_code&code=c&resource=${encodeURIComponent("https://api.example.test/mcp")}`,
    );
    expect(ours.status).toBe(200);
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { body: string };
    expect(init.body).toBe("grant_type=authorization_code&code=c");
    vi.unstubAllGlobals();
  });
});

describe("confirming a proposal re-checks the operation", () => {
  it("refuses an unknown, Aurora, Restricted or ungranted operation before anything is written", async () => {
    const { operationAllowed, RESTRICTED_GROUPS } = await import("@/lib/mcp/apply");
    const { OPERATIONS } = await import("@ghxstship/xos-sdk");
    const update = OPERATIONS["projects.update"];
    expect(operationAllowed("projects.update", [...update.scopes])).toBe(update);
    expect(operationAllowed("projects.update", [])).toBe("agent_outside_grant");
    expect(operationAllowed("projects.get", [...update.scopes])).toBe("agent_operation_unknown");
    expect(operationAllowed("no.suchThing", ["projects"])).toBe("agent_operation_unknown");
    const aurora = Object.values(OPERATIONS).find(
      (o) => o.id.startsWith("ai") && o.method !== "GET",
    );
    if (aurora)
      expect(operationAllowed(aurora.id, [...aurora.scopes])).toBe("agent_operation_unknown");
    expect(RESTRICTED_GROUPS.has("org")).toBe(true);
    expect(RESTRICTED_GROUPS.has("audit")).toBe(true);
    const restricted = Object.values(OPERATIONS).find(
      (o) =>
        o.method !== "GET" &&
        o.scopes.some((s) => RESTRICTED_GROUPS.has(s)) &&
        !o.id.startsWith("ai"),
    );
    if (restricted) {
      expect(operationAllowed(restricted.id, [...restricted.scopes])).toBe(
        "agent_operation_restricted",
      );
    }
  });
});
