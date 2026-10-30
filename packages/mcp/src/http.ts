/**
 * The hosted Streamable HTTP transport (MCP 2025-06-18, 2025-03-26 also accepted; B16, ADR 0155 D1), stateless:
 * every POST carries one JSON-RPC message and is its own session, so there is no Mcp-Session-Id and no
 * server-initiated stream. GET and DELETE answer 405, a request answers application/json, a notification or a
 * response answers 202 with no body. The caller authenticates the request before handing it here and builds the
 * session for the negotiated revision.
 *
 * Checks, in order: the method (POST only), Origin (absent, or one the caller allows: a browser page elsewhere must
 * not drive the endpoint with a user's token, as the MCP specification requires), Content-Type application/json,
 * Accept naming application/json, MCP-Protocol-Version (missing means 2025-03-26, as the specification says), a body
 * of at most 1 MB holding one message, never a batch. No CORS headers are sent.
 */
import { ERROR, HTTP_VERSIONS, type JsonRpcResponse, type McpSession } from "./protocol.ts";

/** The largest request body taken, in bytes. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** The revision a request without MCP-Protocol-Version speaks (MCP 2025-06-18, transports). */
export const DEFAULT_HTTP_VERSION = "2025-03-26";

export interface McpHttpDeps {
  /** The session for one request, at the negotiated revision. */
  readonly session: (protocolVersion: string) => McpSession | Promise<McpSession>;
  /** Origins a browser may call from (for example https://claude.ai); an absent Origin is always allowed. */
  readonly allowedOrigins: readonly string[];
}

function rpcError(status: number, code: number, message: string): Response {
  const body: JsonRpcResponse = { jsonrpc: "2.0", id: null, error: { code, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function plain(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/** The revision a request speaks: its MCP-Protocol-Version header, the default when absent, or null when unsupported. */
export function requestProtocolVersion(headers: Headers): string | null {
  const named = headers.get("mcp-protocol-version");
  if (named === null) return DEFAULT_HTTP_VERSION;
  return (HTTP_VERSIONS as readonly string[]).includes(named.trim()) ? named.trim() : null;
}

function acceptsJson(accept: string | null): boolean {
  if (accept === null) return false;
  return accept
    .split(",")
    .map((part) => part.split(";")[0]?.trim().toLowerCase() ?? "")
    .some((type) => type === "application/json" || type === "application/*" || type === "*/*");
}

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) return null;
  return new TextDecoder().decode(bytes);
}

/** Answers one Streamable HTTP request. */
export async function handleMcpHttp(request: Request, deps: McpHttpDeps): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "POST") {
    return plain(
      405,
      "This MCP endpoint takes POST only; it opens no stream and keeps no session.",
      {
        allow: "POST",
      },
    );
  }
  const origin = request.headers.get("origin");
  if (origin !== null && !deps.allowedOrigins.includes(origin)) {
    return plain(403, "Requests from this origin are not accepted.");
  }
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return plain(415, "Send the JSON-RPC message as application/json.");
  }
  if (!acceptsJson(request.headers.get("accept"))) {
    return plain(406, "Accept application/json: this endpoint answers with JSON, never a stream.");
  }
  const version = requestProtocolVersion(request.headers);
  if (version === null) {
    return plain(
      400,
      `Unsupported MCP-Protocol-Version. This server speaks ${HTTP_VERSIONS.join(" and ")}.`,
    );
  }
  const body = await readBody(request);
  if (body === null) return plain(413, "The request is larger than 1 MB.");
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch (error) {
    return rpcError(400, ERROR.parse, `Parse error: ${(error as Error).message}`);
  }
  if (Array.isArray(message)) {
    return rpcError(
      400,
      ERROR.invalidRequest,
      "Batches are not supported; send one message per request.",
    );
  }
  const record =
    typeof message === "object" && message !== null ? (message as Record<string, unknown>) : null;
  const hasId = record !== null && "id" in record;
  const hasMethod = record !== null && typeof record["method"] === "string";
  if (record !== null && (!hasId || !hasMethod)) {
    // A notification, or a response to a request this server never sends: accepted, nothing to answer.
    if (!hasMethod && !("result" in record) && !("error" in record)) {
      return rpcError(
        400,
        ERROR.invalidRequest,
        "Invalid request: expected a JSON-RPC 2.0 message.",
      );
    }
    return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  }
  const session = await deps.session(version);
  const answer = await session.handle(message);
  if (answer === null)
    return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  return new Response(JSON.stringify(answer), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
