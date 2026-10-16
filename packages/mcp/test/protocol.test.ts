/** MCP 2025-06-18 conformance: lifecycle, tools/list, tools/call and JSON-RPC error codes. */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ToolProvider } from "../src/protocol.ts";
import { ERROR, InvalidParams, McpSession, PROTOCOL_VERSION } from "../src/protocol.ts";
import { serveStdio } from "../src/server.ts";

const tools: ToolProvider = {
  list: () => [
    {
      name: "echo",
      title: "Echo",
      description: "Echoes text.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      annotations: { readOnlyHint: true },
    },
  ],
  async call(name, args) {
    if (typeof args["text"] !== "string") throw new InvalidParams("text must be a string.");
    if (args["text"] === "boom") throw new Error("exploded");
    return { content: [{ type: "text", text: `${name}:${args["text"]}` }], isError: false };
  },
};

const info = { name: "xos-mcp", title: "XOS", version: "0.0.0", instructions: "Test server." };

async function ready(): Promise<McpSession> {
  const session = new McpSession(info, tools);
  await session.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    },
  });
  expect(await session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  return session;
}

describe("lifecycle", () => {
  it("answers initialize with the negotiated version, capabilities and server info", async () => {
    const session = new McpSession(info, tools);
    const response = await session.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "xos-mcp", title: "XOS", version: "0.0.0" },
        instructions: "Test server.",
      },
    });
  });

  it("accepts an older supported version and counters an unknown one with its own", async () => {
    const older = new McpSession(info, tools);
    const a = await older.handle({
      jsonrpc: "2.0",
      id: "a",
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect((a?.result as { protocolVersion: string }).protocolVersion).toBe("2025-03-26");
    expect(older.negotiatedVersion).toBe("2025-03-26");
    const future = new McpSession(info, tools);
    const b = await future.handle({
      jsonrpc: "2.0",
      id: "b",
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    });
    expect((b?.result as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("refuses initialize without a protocol version", async () => {
    const r = await new McpSession(info, tools).handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(r?.error?.code).toBe(ERROR.invalidParams);
  });

  it("answers ping at any time, and refuses tools before initialization", async () => {
    const session = new McpSession(info, tools);
    expect(await session.handle({ jsonrpc: "2.0", id: 7, method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {},
    });
    const early = await session.handle({ jsonrpc: "2.0", id: 8, method: "tools/list" });
    expect(early?.error?.code).toBe(ERROR.invalidRequest);
  });
});

describe("tools", () => {
  it("lists tools with input schemas and annotations", async () => {
    const r = await (
      await ready()
    ).handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(r?.result).toEqual({ tools: tools.list() });
  });

  it("calls a tool", async () => {
    const r = await (
      await ready()
    ).handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });
    expect(r?.result).toEqual({ content: [{ type: "text", text: "echo:hi" }], isError: false });
  });

  it("answers an unknown tool and bad arguments with -32602", async () => {
    const session = await ready();
    expect(
      (
        await session.handle({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "nope" },
        })
      )?.error?.code,
    ).toBe(ERROR.invalidParams);
    expect(
      (
        await session.handle({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "echo", arguments: { text: 1 } },
        })
      )?.error?.code,
    ).toBe(ERROR.invalidParams);
    expect(
      (
        await session.handle({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { arguments: {} },
        })
      )?.error?.code,
    ).toBe(ERROR.invalidParams);
    expect(
      (
        await session.handle({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "echo", arguments: [] },
        })
      )?.error?.code,
    ).toBe(ERROR.invalidParams);
  });

  it("reports an unexpected failure as -32603", async () => {
    const r = await (
      await ready()
    ).handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "boom" } },
    });
    expect(r?.error).toEqual({ code: ERROR.internal, message: "Internal error: exploded" });
  });
});

describe("JSON-RPC errors", () => {
  it("returns -32700 for malformed JSON", async () => {
    const r = await new McpSession(info, tools).handleText("{oops");
    expect(r?.error?.code).toBe(ERROR.parse);
    expect(r?.id).toBeNull();
  });

  it("returns -32600 for invalid requests and batches", async () => {
    const session = new McpSession(info, tools);
    expect((await session.handle({ id: 1, method: "ping" }))?.error).toMatchObject({
      code: ERROR.invalidRequest,
    });
    expect((await session.handle({ jsonrpc: "2.0", id: 1 }))?.id).toBe(1);
    expect(
      (await session.handle({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" }))?.error?.code,
    ).toBe(ERROR.invalidRequest);
    expect((await session.handle([{ jsonrpc: "2.0", id: 1, method: "ping" }]))?.error?.code).toBe(
      ERROR.invalidRequest,
    );
    expect((await session.handle("text"))?.error?.code).toBe(ERROR.invalidRequest);
  });

  it("returns -32601 for unknown methods and -32602 for non-object params", async () => {
    const session = new McpSession(info, tools);
    expect(
      (await session.handle({ jsonrpc: "2.0", id: 1, method: "resources/list" }))?.error?.code,
    ).toBe(ERROR.methodNotFound);
    expect(
      (await session.handle({ jsonrpc: "2.0", id: 2, method: "ping", params: [1] }))?.error?.code,
    ).toBe(ERROR.invalidParams);
  });

  it("never answers notifications, even malformed ones", async () => {
    const session = new McpSession(info, tools);
    expect(
      await session.handle({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      }),
    ).toBeNull();
    expect(await session.handle({ jsonrpc: "2.0", method: "anything", params: [1] })).toBeNull();
  });
});

describe("stdio transport", () => {
  it("reads newline-delimited messages and writes one line per response", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const done = serveStdio(new McpSession(info, tools), input, (line) => lines.push(line));
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION } })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n\n`);
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "x" } } })}\n`,
    );
    input.end("not json\n");
    await done;
    const parsed = lines.map((l) => JSON.parse(l) as { id: unknown; error?: { code: number } });
    expect(lines.every((l) => l.endsWith("\n") && !l.slice(0, -1).includes("\n"))).toBe(true);
    expect(parsed.map((p) => p.id).sort()).toEqual([1, 2, null].sort());
    expect(parsed.find((p) => p.id === null)?.error?.code).toBe(ERROR.parse);
  });
});
