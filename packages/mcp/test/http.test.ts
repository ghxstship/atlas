/** The hosted Streamable HTTP transport (B16, ADR 0155 D1): stateless, POST only, JSON only, one message. */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HTTP_VERSION,
  MAX_BODY_BYTES,
  handleMcpHttp,
  requestProtocolVersion,
} from "../src/http.ts";
import { McpSession, type ToolProvider } from "../src/protocol.ts";

const tools: ToolProvider = {
  list: () => [
    {
      name: "echo",
      title: "Echo",
      description: "Echoes.",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
  ],
  call: async (_name, args) => ({
    content: [{ type: "text", text: JSON.stringify(args) }],
    isError: false,
  }),
};

const versions: string[] = [];
const deps = {
  allowedOrigins: ["https://claude.ai", "https://atlas.example.test"],
  session: (version: string) => {
    versions.push(version);
    return new McpSession({ name: "t", title: "T", version: "1", instructions: "" }, tools, {
      lifecycle: "stateless",
      protocolVersion: version,
    });
  },
};

function post(body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("https://atlas.example.test/api/mcp", {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

describe("Streamable HTTP, stateless", () => {
  it("answers initialize, tools/list and tools/call without a session id", async () => {
    const init = await handleMcpHttp(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      deps,
    );
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toBe("application/json");
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect(
      ((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion,
    ).toBe("2025-06-18");
    const list = await handleMcpHttp(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }), deps);
    expect(((await list.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(1);
    const called = await handleMcpHttp(
      post({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { a: 1 } },
      }),
      deps,
    );
    expect(((await called.json()) as { result: { isError: boolean } }).result.isError).toBe(false);
    expect(called.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("negotiates 2025-03-26 and never offers 2024-11-05 over HTTP", async () => {
    const older = await handleMcpHttp(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      }),
      deps,
    );
    expect(
      ((await older.json()) as { result: { protocolVersion: string } }).result.protocolVersion,
    ).toBe("2025-03-26");
    const oldest = await handleMcpHttp(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      }),
      deps,
    );
    expect(
      ((await oldest.json()) as { result: { protocolVersion: string } }).result.protocolVersion,
    ).toBe("2025-06-18");
  });

  it("answers a notification and a response with 202 and no body", async () => {
    const note = await handleMcpHttp(
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
      deps,
    );
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    const reply = await handleMcpHttp(post({ jsonrpc: "2.0", id: 9, result: {} }), deps);
    expect(reply.status).toBe(202);
  });

  it("reads the revision from MCP-Protocol-Version, 2025-03-26 when absent", async () => {
    versions.length = 0;
    const headers = new Headers();
    expect(requestProtocolVersion(headers)).toBe(DEFAULT_HTTP_VERSION);
    await handleMcpHttp(
      post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "2025-03-26" }),
      deps,
    );
    expect(versions).toEqual(["2025-03-26"]);
    const bad = await handleMcpHttp(
      post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "2024-11-05" }),
      deps,
    );
    expect(bad.status).toBe(400);
  });

  it.each([
    ["GET", 405],
    ["DELETE", 405],
  ])("answers %s with %i", async (method, status) => {
    const response = await handleMcpHttp(post(null, {}, method), deps);
    expect(response.status).toBe(status);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("refuses a batch, a large body, the wrong types and a foreign origin", async () => {
    const batch = await handleMcpHttp(post([{ jsonrpc: "2.0", id: 1, method: "ping" }]), deps);
    expect(batch.status).toBe(400);
    const large = await handleMcpHttp(post("x".repeat(MAX_BODY_BYTES + 1)), deps);
    expect(large.status).toBe(413);
    const type = await handleMcpHttp(post({}, { "content-type": "text/plain" }), deps);
    expect(type.status).toBe(415);
    const accept = await handleMcpHttp(post({}, { accept: "text/event-stream" }), deps);
    expect(accept.status).toBe(406);
    const origin = await handleMcpHttp(
      post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example.test" }),
      deps,
    );
    expect(origin.status).toBe(403);
    const allowed = await handleMcpHttp(
      post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://claude.ai" }),
      deps,
    );
    expect(allowed.status).toBe(200);
    const parse = await handleMcpHttp(post("{not json"), deps);
    expect(parse.status).toBe(400);
  });
});
