/**
 * Wires the SDK client, the tools and the protocol session together. On stdio the server acts as one API key
 * (xos-mcp); hosted (B16, ADR 0155 D1) it acts as the OAuth access token of an app the person connected, and every
 * write is a proposal the person confirms in XOS.
 */
import { API_VERSION, XosClient } from "@ghxstship/xos-sdk";
import type { Propose, WriteScope } from "./tools.ts";
import { PROPOSE_ALL, createTools, parseWriteScope } from "./tools.ts";
import { McpSession } from "./protocol.ts";

export { serveStdio } from "./stdio.ts";

export const SERVER_VERSION = "0.1.0";

export interface McpServerOptions {
  /** API base URL including the version, for example https://api.ghxstship.tech/v1. */
  readonly baseUrl: string;
  /** Org-scoped `xos_live_` API key. The server acts with exactly its permissions. */
  readonly apiKey: string;
  readonly scope: WriteScope;
  readonly fetch?: typeof fetch;
}

/** The hosted endpoint's session (B16): an app's OAuth access token, and proposals instead of writes. */
export interface HostedSessionOptions {
  readonly baseUrl: string;
  /** The OAuth access token Supabase Auth issued to the connected app. */
  readonly accessToken: string;
  /** The capability groups of the person's live grant to the app. */
  readonly grantScopes: readonly string[];
  readonly propose: Propose;
  /** The revision the request's MCP-Protocol-Version header named. */
  readonly protocolVersion: string;
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

function hostedInstructions(): string {
  return [
    `Tools for the XOS public API ${API_VERSION}, acting for the person who connected you, within the capability groups they granted, in one organization.`,
    "Find resources with xos_list_resources and schemas with xos_describe_operation.",
    "Reads answer at once. Every write (xos_create, xos_update, xos_action, xos_delete) proposes the change for the person to confirm in XOS, Personal settings, Connected apps; nothing changes until they do, and a proposal expires after 7 days. Tell the person to review it, with the review link the tool returns.",
    "Refusals (NO_ANSWER, UNRATIFIED, REFUSE) are answers: report the reason, never work around it.",
    "Money is integer minor units and null means unpriced, never zero.",
  ].join(" ");
}

function documentLoader(client: XosClient, token: string, fetcher: typeof fetch | undefined) {
  let document: Promise<Record<string, unknown>> | null = null;
  return () => {
    document ??= (async () => {
      const response = await (fetcher ?? fetch)(`${client.baseUrl}/openapi.json`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!response.ok) {
        document = null;
        throw new Error(`The API did not serve its OpenAPI document (HTTP ${response.status}).`);
      }
      return (await response.json()) as Record<string, unknown>;
    })();
    return document;
  };
}

export function createSession(options: McpServerOptions): McpSession {
  const client = new XosClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return new McpSession(
    {
      name: "xos-mcp",
      title: "XOS",
      version: SERVER_VERSION,
      instructions: instructions(options.scope),
    },
    createTools({
      client,
      scope: options.scope,
      fetchDocument: documentLoader(client, options.apiKey, options.fetch),
    }),
  );
}

/** One stateless session of the hosted endpoint, for one request. */
export function createHostedSession(options: HostedSessionOptions): McpSession {
  const client = new XosClient({
    baseUrl: options.baseUrl,
    accessToken: options.accessToken,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return new McpSession(
    {
      name: "xos-mcp",
      title: "XOS",
      version: SERVER_VERSION,
      instructions: hostedInstructions(),
    },
    createTools({
      client,
      scope: PROPOSE_ALL,
      fetchDocument: documentLoader(client, options.accessToken, options.fetch),
      propose: options.propose,
      grantScopes: options.grantScopes,
    }),
    { lifecycle: "stateless", protocolVersion: options.protocolVersion },
  );
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
