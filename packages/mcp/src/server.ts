/** Wires the SDK client, the tools and the protocol session together, and runs them over stdio. */
import { createInterface } from "node:readline";
import { API_VERSION, XosClient } from "@xos/sdk";
import type { WriteScope } from "./tools.ts";
import { createTools, parseWriteScope } from "./tools.ts";
import { McpSession } from "./protocol.ts";

export const SERVER_VERSION = "0.0.0";

export interface McpServerOptions {
  /** API base URL including the version, for example https://api.ghxstship.tech/v1. */
  readonly baseUrl: string;
  /** Org-scoped `xos_live_` API key. The server acts with exactly its permissions. */
  readonly apiKey: string;
  readonly scope: WriteScope;
  readonly fetch?: typeof fetch;
}

function instructions(scope: WriteScope): string {
  const writes = scope.all
    ? "Writes are enabled for every resource the key may write."
    : scope.resources.size + scope.modules.size > 0
      ? `Writes are enabled only for: ${[...scope.modules, ...scope.resources].join(", ")}.`
      : "This server is read-only.";
  return [
    `Tools for the XOS public API ${API_VERSION}, acting as one API key in one organization.`,
    "Find resources with xos_list_resources and schemas with xos_describe_operation.",
    writes,
    "Refusals (NO_ANSWER, UNRATIFIED, REFUSE) are answers: report the reason, never work around it.",
    "Money is integer minor units and null means unpriced, never zero.",
  ].join(" ");
}

export function createSession(options: McpServerOptions): McpSession {
  const client = new XosClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  let document: Promise<Record<string, unknown>> | null = null;
  const fetchDocument = () => {
    document ??= (async () => {
      const response = await (options.fetch ?? fetch)(`${client.baseUrl}/openapi.json`, {
        headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
      });
      if (!response.ok) {
        document = null;
        throw new Error(`The API did not serve its OpenAPI document (HTTP ${response.status}).`);
      }
      return (await response.json()) as Record<string, unknown>;
    })();
    return document;
  };
  return new McpSession(
    {
      name: "xos-mcp",
      title: "XOS",
      version: SERVER_VERSION,
      instructions: instructions(options.scope),
    },
    createTools({ client, scope: options.scope, fetchDocument }),
  );
}

/** Reads newline-delimited JSON-RPC messages and writes one response line per request. */
export function serveStdio(
  session: McpSession,
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    const task = session.handleText(line).then((response) => {
      if (response) write(`${JSON.stringify(response)}\n`);
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  return new Promise((resolve) => {
    lines.on("close", () => {
      void Promise.all(pending).then(() => resolve());
    });
  });
}

export interface CliArgs {
  readonly write?: string | undefined;
  readonly allowDelete?: boolean | undefined;
}

export function optionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  args: CliArgs,
): McpServerOptions {
  const apiKey = env["XOS_API_KEY"];
  const baseUrl = env["XOS_BASE_URL"];
  if (!apiKey || !baseUrl) {
    throw new Error(
      "Set XOS_API_KEY to an org-scoped API key and XOS_BASE_URL to the API base URL, for example https://api.ghxstship.tech/v1.",
    );
  }
  const allowDelete = args.allowDelete ?? env["XOS_MCP_ALLOW_DELETE"] === "true";
  return {
    apiKey,
    baseUrl,
    scope: parseWriteScope(args.write ?? env["XOS_MCP_WRITE"], allowDelete),
  };
}
