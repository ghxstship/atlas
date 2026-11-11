/** The XOS tools against the contract test server: reads, scoped writes and error reporting. */
import type { ContractServer } from "@ghxstship/xos-sdk/test-server";
import { startContractServer } from "@ghxstship/xos-sdk/test-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonRpcResponse, ToolResult } from "../src/protocol.ts";
import { ERROR, PROTOCOL_VERSION } from "../src/protocol.ts";
import type { McpSession } from "../src/protocol.ts";
import { createHostedSession, createSession, optionsFromEnv } from "../src/server.ts";
import type { ProposalInput } from "../src/tools.ts";
import { ProposalRefusal, READ_ONLY, canWrite, parseWriteScope } from "../src/tools.ts";
import { OPERATIONS } from "@ghxstship/xos-sdk";

let server: ContractServer;
let nextId = 1;

beforeAll(async () => {
  server = await startContractServer();
});

afterAll(async () => {
  expect(server.violations).toEqual([]);
  await server.close();
});

async function session(write?: string, allowDelete = false, apiKey?: string): Promise<McpSession> {
  const s = createSession({
    baseUrl: server.baseUrl,
    apiKey: apiKey ?? server.apiKey,
    scope: parseWriteScope(write, allowDelete),
  });
  await s.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION },
  });
  await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  return s;
}

async function call(
  s: McpSession,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: ToolResult; data: Record<string, unknown> }> {
  const response = (await s.handle({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  })) as JsonRpcResponse;
  if (response.error) throw new Error(`${response.error.code} ${response.error.message}`);
  const result = response.result as ToolResult;
  return { result, data: JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown> };
}

async function toolNames(s: McpSession): Promise<string[]> {
  const r = await s.handle({ jsonrpc: "2.0", id: nextId++, method: "tools/list" });
  return (r?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
}

const project = {
  name: "MCP Show",
  project_key: "MCP-1",
  time_zone: "UTC",
  tier_code: "04",
  currency: "USD",
};

describe("tool sets", () => {
  it("is read-only by default", async () => {
    expect(await toolNames(await session())).toEqual([
      "xos_list_resources",
      "xos_describe_operation",
      "xos_whoami",
      "xos_list",
      "xos_get",
      "xos_read",
    ]);
  });

  it("adds write tools for a scope, and delete only with --allow-delete", async () => {
    expect(await toolNames(await session("Projects"))).toContain("xos_update");
    expect(await toolNames(await session("Projects"))).not.toContain("xos_delete");
    expect(await toolNames(await session("all", true))).toContain("xos_delete");
  });

  it("parses scopes from resources and modules and refuses unknown entries", () => {
    const scope = parseWriteScope("purchase-orders, finance", false);
    expect([...scope.resources]).toEqual(["purchaseOrders"]);
    expect([...scope.modules]).toEqual(["Finance"]);
    expect(canWrite(scope, OPERATIONS["purchaseOrders.approve"])).toBe(true);
    expect(canWrite(scope, OPERATIONS["projects.create"])).toBe(false);
    expect(canWrite(READ_ONLY, OPERATIONS["projects.list"])).toBe(true);
    expect(canWrite(parseWriteScope("all", false), OPERATIONS["calendars.delete"])).toBe(false);
    expect(() => parseWriteScope("nonsense", false)).toThrow(/neither a resource nor a module/);
  });

  it("reads credentials and scope from the environment", () => {
    expect(() => optionsFromEnv({}, {})).toThrow(/XOS_API_KEY/);
    const options = optionsFromEnv(
      {
        XOS_API_KEY: "k",
        XOS_BASE_URL: "http://x",
        XOS_MCP_WRITE: "Projects",
        XOS_MCP_ALLOW_DELETE: "true",
      },
      {},
    );
    expect(options.scope.allowDelete).toBe(true);
    expect([...options.scope.modules]).toEqual(["Projects"]);
    expect(
      optionsFromEnv(
        { XOS_API_KEY: "k", XOS_BASE_URL: "http://x" },
        { write: "all", allowDelete: false },
      ).scope.all,
    ).toBe(true);
  });
});

describe("read tools", () => {
  it("lists resources, filtered by module", async () => {
    const s = await session();
    const { data } = await call(s, "xos_list_resources", { module: "Finance" });
    const resources = data["resources"] as { module: string }[];
    expect(resources.length).toBeGreaterThan(0);
    expect(resources.every((r) => r.module === "Finance")).toBe(true);
    const bad = await s.handle({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "xos_list_resources", arguments: { module: "Nope" } },
    });
    expect(bad?.error?.code).toBe(ERROR.invalidParams);
  });

  it("describes an operation with its schemas from the served document", async () => {
    const { data } = await call(await session(), "xos_describe_operation", {
      operation_id: "projects.create",
    });
    expect((data["request_body"] as { name: string }).name).toBe("ProjectCreate");
    expect((data["response"] as { schema: { type: string } }).schema.type).toBe("object");
  });

  it("reports when the API does not serve its document", async () => {
    const s = createSession({
      baseUrl: server.baseUrl,
      apiKey: server.apiKey,
      scope: READ_ONLY,
      fetch: async (url, init) =>
        String(url).endsWith("/openapi.json")
          ? new Response("", { status: 503 })
          : fetch(url, init),
    });
    await s.handle({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION },
    });
    await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    const r = await s.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "xos_describe_operation", arguments: { operation_id: "projects.get" } },
    });
    expect(r?.error?.message).toMatch(/did not serve its OpenAPI document/);
  });

  it("whoami, list, get and read", async () => {
    server.seed("/projects", { id: "0192f1e2-7c3a-7b4d-9e8f-000000000001", name: "Seeded Show" });
    const s = await session();
    expect((await call(s, "xos_whoami", {})).data).toHaveProperty("person_id");
    const listed = await call(s, "xos_list", {
      resource: "projects",
      filter: { name: { eq: "Seeded Show" } },
      fields: "name",
      sort: "name",
      limit: 5,
    });
    expect(listed.data["data"]).toEqual([
      { id: "0192f1e2-7c3a-7b4d-9e8f-000000000001", name: "Seeded Show" },
    ]);
    expect(listed.result.structuredContent).toEqual(listed.data);
    const got = await call(s, "xos_get", {
      resource: "projects",
      id: "0192f1e2-7c3a-7b4d-9e8f-000000000001",
      fields: "name",
    });
    expect(got.data["etag"]).toMatch(/^W\//);
    const read = await call(s, "xos_read", {
      operation_id: "canonElements.resolve",
      query: { query: "stage deck" },
    });
    expect(read.result.isError).toBe(false);
    const page = await call(s, "xos_read", { operation_id: "projects.list", query: { limit: 1 } });
    expect(page.data).toHaveProperty("next_cursor");
  });

  it("turns malformed arguments into -32602 and API problems into tool errors", async () => {
    const s = await session();
    const bad = async (name: string, args: Record<string, unknown>) =>
      (
        await s.handle({
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name, arguments: args },
        })
      )?.error?.code;
    expect(await bad("xos_list", {})).toBe(ERROR.invalidParams);
    expect(await bad("xos_list", { resource: "projects", limit: 0 })).toBe(ERROR.invalidParams);
    expect(await bad("xos_list", { resource: "projects", filter: "x" })).toBe(ERROR.invalidParams);
    expect(await bad("xos_list", { resource: "nope" })).toBe(ERROR.invalidParams);
    expect(await bad("xos_get", { resource: "projects" })).toBe(ERROR.invalidParams);
    expect(await bad("xos_read", { operation_id: "projects.create" })).toBe(ERROR.invalidParams);
    expect(await bad("xos_read", { operation_id: "nope.nope" })).toBe(ERROR.invalidParams);
    expect(await bad("xos_read", { operation_id: "canonElements.resolve" })).toBe(
      ERROR.invalidParams,
    );
    const missing = await call(s, "xos_get", {
      resource: "projects",
      id: "0192f1e2-7c3a-7b4d-9e8f-00000000ffff",
    });
    expect(missing.result.isError).toBe(true);
    expect(missing.data).toMatchObject({ error: "api_error", status: 404 });
  });

  it("reports a rejected key and an unreachable API as tool errors", async () => {
    const denied = await call(await session(undefined, false, "xos_live_wrong"), "xos_whoami", {});
    expect(denied.data).toMatchObject({ error: "api_error", status: 401 });
    const down = createSession({
      baseUrl: "http://127.0.0.1:9/api/v1",
      apiKey: "k",
      scope: READ_ONLY,
      fetch: async () => Promise.reject(new Error("refused")),
    });
    await down.handle({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION },
    });
    await down.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    const r = await down.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "xos_whoami", arguments: {} },
    });
    expect(JSON.parse((r?.result as ToolResult).content[0]?.text ?? "{}")).toMatchObject({
      error: "network_error",
    });
  });
});

describe("scoped write tools", () => {
  it("creates, updates and acts within scope, with idempotency keys", async () => {
    const s = await session("Projects");
    const created = await call(s, "xos_create", {
      resource: "projects",
      body: project,
      idempotency_key: "mcp-create-0001",
    });
    const replay = await call(s, "xos_create", {
      resource: "projects",
      body: project,
      idempotency_key: "mcp-create-0001",
    });
    const id = (created.data["data"] as { id: string }).id;
    expect((replay.data["data"] as { id: string }).id).toBe(id);
    const read = await call(s, "xos_get", { resource: "projects", id });
    const updated = await call(s, "xos_update", {
      resource: "projects",
      id,
      body: { name: "MCP Show Two" },
      if_match: read.data["etag"],
    });
    expect((updated.data["data"] as { name: string }).name).toBe("MCP Show Two");
    const stale = await call(s, "xos_update", {
      resource: "projects",
      id,
      body: { name: "x" },
      if_match: read.data["etag"],
    });
    expect(stale.data).toMatchObject({ status: 412 });
    const refused = await call(s, "xos_action", {
      operation_id: "projects.transition",
      id,
      body: { expected_state: "Closed", to_state: "Active" },
    });
    expect(refused.result.isError).toBe(true);
    expect((refused.data["problem"] as { refusal: string }).refusal).toBe("REFUSE");
    const archived = await call(s, "xos_action", {
      operation_id: "projects.archive",
      id,
      idempotency_key: "mcp-archive-001",
    });
    expect(archived.result.isError).toBe(false);
  });

  it("refuses writes outside the scope without calling the API", async () => {
    const s = await session("Projects");
    const before = server.requests.length;
    const outside = await call(s, "xos_create", {
      resource: "calendars",
      body: { name: "C", time_zone: "UTC" },
    });
    expect(outside.result.isError).toBe(true);
    expect(outside.data).toMatchObject({ error: "outside_write_scope" });
    expect(String(outside.data["detail"])).toMatch(/--write calendars/);
    expect(server.requests.length).toBe(before);
    const wrongVerb = await s.handle({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name: "xos_action", arguments: { operation_id: "projects.list" } },
    });
    expect(wrongVerb?.error?.code).toBe(ERROR.invalidParams);
  });

  it("deletes only with --allow-delete", async () => {
    const s = await session("all", true);
    const created = await call(s, "xos_create", {
      resource: "calendars",
      body: { name: "Doomed", time_zone: "UTC" },
    });
    const id = (created.data["data"] as { id: string }).id;
    expect((await call(s, "xos_delete", { resource: "calendars", id })).data).toEqual({
      deleted: true,
    });
    const noDelete = await session("all", false);
    const r = await noDelete.handle({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name: "xos_delete", arguments: { resource: "calendars", id } },
    });
    expect(r?.error?.code).toBe(ERROR.invalidParams);
  });
});

describe("hosted mode: writes are proposals (B16)", () => {
  function hosted(grantScopes: readonly string[], refuse?: string) {
    const proposals: { operation: string; input: ProposalInput }[] = [];
    const s = createHostedSession({
      baseUrl: server.baseUrl,
      accessToken: server.apiKey,
      grantScopes,
      protocolVersion: "2025-06-18",
      propose: async (spec, input) => {
        if (refuse) throw new ProposalRefusal(refuse, "The organization is paused.");
        proposals.push({ operation: spec.id, input });
        return {
          suggestionId: `s-${proposals.length}`,
          expiresAt: "2026-11-06T12:00:00Z",
          reviewUrl: "https://atlas.example.test/northwind-live/me/connected-apps",
        };
      },
    });
    return { s, proposals };
  }

  const scopes = OPERATIONS["projects.update"].scopes;

  it("needs no initialize, lists every write tool as a proposal and names the 7-day expiry", async () => {
    const { s } = hosted(scopes);
    const r = await s.handle({ jsonrpc: "2.0", id: nextId++, method: "tools/list" });
    const tools = (
      r?.result as {
        tools: {
          name: string;
          description: string;
          inputSchema: { properties: Record<string, unknown> };
        }[];
      }
    ).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "xos_list_resources",
      "xos_describe_operation",
      "xos_whoami",
      "xos_list",
      "xos_get",
      "xos_read",
      "xos_create",
      "xos_update",
      "xos_action",
      "xos_delete",
    ]);
    const update = tools.find((t) => t.name === "xos_update");
    expect(update?.description).toMatch(
      /^Proposes updating the fields sent for the person to confirm in XOS; nothing changes until they do/,
    );
    expect(update?.inputSchema.properties).toHaveProperty("summary");
    const init = await s.handle({
      jsonrpc: "2.0",
      id: nextId++,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    const result = init?.result as { protocolVersion: string; instructions: string };
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.instructions).toMatch(/expires after 7 days/);
  });

  it("records an update as a proposal with its path, If-Match and fields, and never writes", async () => {
    const { s, proposals } = hosted(scopes);
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const { result, data } = await call(s, "xos_update", {
      resource: "projects",
      id,
      body: { name: "Encore", description: null },
      if_match: 'W/"1"',
    });
    expect(result.isError).toBe(false);
    expect(data).toEqual({
      proposed: true,
      suggestion_id: "s-1",
      expires_at: "2026-11-06T12:00:00Z",
      review_url: "https://atlas.example.test/northwind-live/me/connected-apps",
    });
    expect(proposals[0]).toEqual({
      operation: "projects.update",
      input: {
        path: { id },
        body: { name: "Encore", description: null },
        ifMatch: 'W/"1"',
        idempotencyKey: null,
        summary: `${OPERATIONS["projects.update"].summary}: projects ${id}`,
        targetId: id,
      },
    });
    await call(s, "xos_update", {
      resource: "projects",
      id,
      body: { name: "Encore" },
      if_match: 'W/"1"',
      summary: "Rename the tour for the encore.",
    });
    expect(proposals[1]?.input.summary).toBe("Rename the tour for the encore.");
  });

  it("refuses operations outside the grant and Aurora's own, without proposing", async () => {
    const { s, proposals } = hosted(["home"]);
    const outside = await call(s, "xos_create", { resource: "projects", body: project });
    expect(outside.result.isError).toBe(true);
    expect(outside.data["error"]).toBe("outside_granted_scopes");
    const all = hosted(Object.values(OPERATIONS).flatMap((o) => o.scopes));
    const aurora = Object.values(OPERATIONS).find(
      (o) => o.id.startsWith("ai") && o.method === "POST",
    );
    if (aurora) {
      const refused = await call(all.s, "xos_action", { operation_id: aurora.id, path: {} }).catch(
        () => null,
      );
      expect(refused === null || refused.data["error"] === "operation_not_proposable").toBe(true);
    }
    expect(proposals).toEqual([]);
    expect(all.proposals).toEqual([]);
  });

  it("answers a database refusal of the proposal as a tool error", async () => {
    const { s } = hosted(scopes, "org_read_only");
    const { result, data } = await call(s, "xos_update", {
      resource: "projects",
      id: "0f8fad5b-d9cb-469f-a165-70867728950e",
      body: { name: "x" },
      if_match: 'W/"1"',
    });
    expect(result.isError).toBe(true);
    expect(data).toEqual({ error: "org_read_only", detail: "The organization is paused." });
  });

  it("reads through the API with the access token", async () => {
    const { s } = hosted(scopes);
    const { result } = await call(s, "xos_whoami", {});
    expect(result.isError).toBe(false);
  });
});
