/**
 * Model Context Protocol over JSON-RPC 2.0, revision 2025-06-18: lifecycle (initialize,
 * notifications/initialized, ping) and tools (tools/list, tools/call). Transport-agnostic: each
 * incoming message is one parsed JSON value, and the answer is a response or nothing.
 */

export const PROTOCOL_VERSION = "2025-06-18";
/** Revisions this server can speak, newest first. */
export const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export type JsonRpcId = string | number;

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: ToolAnnotations;
}

export interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
}

export interface ToolProvider {
  list(): readonly ToolDefinition[];
  /** Runs a tool. Throws `InvalidParams` for arguments that do not fit its input schema. */
  call(name: string, args: Readonly<Record<string, unknown>>): Promise<ToolResult>;
}

export interface ServerInfo {
  readonly name: string;
  readonly title: string;
  readonly version: string;
  readonly instructions: string;
}

/** A request sent before the lifecycle allows it: answered as JSON-RPC -32600. */
class NotInitialized extends Error {
  override name = "NotInitialized";
}

/** Arguments that do not fit a tool: answered as JSON-RPC -32602, not as a tool error. */
export class InvalidParams extends Error {
  override name = "InvalidParams";
}

function failure(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class McpSession {
  #initialized = false;
  #version: string = PROTOCOL_VERSION;
  readonly #info: ServerInfo;
  readonly #tools: ToolProvider;

  constructor(info: ServerInfo, tools: ToolProvider) {
    this.#info = info;
    this.#tools = tools;
  }

  get negotiatedVersion(): string {
    return this.#version;
  }

  /** Handles one line of input. Returns the response to write, or null for notifications. */
  async handleText(text: string): Promise<JsonRpcResponse | null> {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch (error) {
      return failure(null, ERROR.parse, `Parse error: ${(error as Error).message}`);
    }
    return this.handle(message);
  }

  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (Array.isArray(message)) {
      return failure(
        null,
        ERROR.invalidRequest,
        "Batches are not supported in protocol 2025-06-18; send one message at a time.",
      );
    }
    if (
      !isObject(message) ||
      message["jsonrpc"] !== "2.0" ||
      typeof message["method"] !== "string"
    ) {
      const id =
        isObject(message) &&
        (typeof message["id"] === "string" || typeof message["id"] === "number")
          ? message["id"]
          : null;
      return failure(
        id,
        ERROR.invalidRequest,
        "Invalid request: expected a JSON-RPC 2.0 object with a method.",
      );
    }
    const method = message["method"];
    const params = message["params"];
    const hasId = "id" in message;
    const id = message["id"];
    if (hasId && typeof id !== "string" && typeof id !== "number") {
      return failure(
        null,
        ERROR.invalidRequest,
        "Invalid request: id must be a string or a number.",
      );
    }
    if (params !== undefined && !isObject(params)) {
      return hasId
        ? failure(id as JsonRpcId, ERROR.invalidParams, "params must be an object.")
        : null;
    }
    if (!hasId) {
      // Notifications never get a response.
      if (method === "notifications/initialized") this.#initialized = true;
      return null;
    }
    const requestId = id as JsonRpcId;
    try {
      return await this.#dispatch(requestId, method, params ?? {});
    } catch (error) {
      if (error instanceof InvalidParams)
        return failure(requestId, ERROR.invalidParams, error.message);
      if (error instanceof NotInitialized)
        return failure(requestId, ERROR.invalidRequest, error.message);
      return failure(requestId, ERROR.internal, `Internal error: ${(error as Error).message}`);
    }
  }

  async #dispatch(
    id: JsonRpcId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    switch (method) {
      case "initialize": {
        const requested = params["protocolVersion"];
        if (typeof requested !== "string")
          throw new InvalidParams("initialize needs protocolVersion.");
        this.#version = (SUPPORTED_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : PROTOCOL_VERSION;
        return success(id, {
          protocolVersion: this.#version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: this.#info.name,
            title: this.#info.title,
            version: this.#info.version,
          },
          instructions: this.#info.instructions,
        });
      }
      case "ping":
        return success(id, {});
      case "tools/list":
        this.#requireInitialized();
        return success(id, { tools: this.#tools.list() });
      case "tools/call": {
        this.#requireInitialized();
        const name = params["name"];
        const args = params["arguments"] ?? {};
        if (typeof name !== "string") throw new InvalidParams("tools/call needs the tool name.");
        if (!isObject(args)) throw new InvalidParams("tools/call arguments must be an object.");
        if (!this.#tools.list().some((t) => t.name === name))
          throw new InvalidParams(`Unknown tool: ${name}.`);
        return success(id, await this.#tools.call(name, args));
      }
      default:
        return failure(id, ERROR.methodNotFound, `Method not found: ${method}.`);
    }
  }

  #requireInitialized(): void {
    if (!this.#initialized) {
      throw new NotInitialized(
        "The session is not initialized: send initialize, then notifications/initialized.",
      );
    }
  }
}
