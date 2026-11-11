import type { Env } from "@/lib/env";

/**
 * Hosted MCP connectors (B16, ADR 0155 D1): the assistants' presets, the endpoint's URL and the browser origins it
 * takes requests from. One file, so a vendor changing its callback is a one-line change here (and a migration only if
 * the database ever pins it). Dynamic client registration stays off: an Admin registers a connector from a preset in
 * Settings, Integrations, and the person pastes its client id into the assistant's advanced OAuth settings.
 */

export type McpPresetKind = "Claude" | "ChatGPT";

export interface McpPreset {
  readonly kind: McpPresetKind;
  /** The assistant's OAuth callback, registered as the app's redirect URI. */
  readonly redirectUri: string;
  /** The origin its browser client calls the endpoint from, if it does. */
  readonly origin: string;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    kind: "Claude",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    origin: "https://claude.ai",
  },
  {
    kind: "ChatGPT",
    redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
    origin: "https://chatgpt.com",
  },
];

export function mcpPreset(kind: string): McpPreset | null {
  return MCP_PRESETS.find((p) => p.kind === kind) ?? null;
}

/** Whether the hosted endpoint is on (XOS_MCP_HOSTED=on). */
export function mcpHosted(config: Pick<Env, "XOS_MCP_HOSTED">): boolean {
  return config.XOS_MCP_HOSTED === "on";
}

/** The MCP server URL to give an assistant: https://<XOS_API_HOST>/mcp when the API host is set, else Atlas's /api/mcp. */
export function mcpServerUrl(config: Pick<Env, "XOS_API_HOST" | "ATLAS_SITE_URL">): string {
  if (config.XOS_API_HOST) return `https://${config.XOS_API_HOST}/mcp`;
  return `${config.ATLAS_SITE_URL.replace(/\/$/, "")}/api/mcp`;
}

/** Browser origins allowed to call the endpoint: the assistants' and Atlas's own. */
export function mcpAllowedOrigins(config: Pick<Env, "ATLAS_SITE_URL">): string[] {
  return [...MCP_PRESETS.map((p) => p.origin), new URL(config.ATLAS_SITE_URL).origin];
}

/**
 * The resource URLs a token request may name (RFC 8707): the MCP URL on either host, and the API on either host. An
 * authorization naming any other is refused.
 */
export function oauthResources(config: Pick<Env, "XOS_API_HOST" | "ATLAS_SITE_URL">): string[] {
  const atlas = config.ATLAS_SITE_URL.replace(/\/$/, "");
  const urls = [`${atlas}/api/mcp`, `${atlas}/api/v1`];
  if (config.XOS_API_HOST)
    urls.push(`https://${config.XOS_API_HOST}/mcp`, `https://${config.XOS_API_HOST}/v1`);
  return urls;
}

/**
 * The origin a request reached: its Host header, over https unless it is a loopback host. Next names a loopback host
 * localhost in request.url (ADR 0036), so the Host header decides.
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\]|[^:]+\.localhost)(:\d+)?$/i.test(host);
  const proto =
    request.headers.get("x-forwarded-proto") ??
    (loopback ? url.protocol.replace(":", "") : "https");
  return `${proto === "http" ? "http" : "https"}://${host}`;
}

/** Whether the request came to the API host, where the endpoint lives at /mcp. */
export function onApiHost(request: Request, config: Pick<Env, "XOS_API_HOST">): boolean {
  const host = (request.headers.get("host") ?? new URL(request.url).host)
    .toLowerCase()
    .replace(/:\d+$/, "");
  return config.XOS_API_HOST !== undefined && host === config.XOS_API_HOST;
}

/** The MCP URL on the requesting host. */
export function mcpUrlFor(request: Request, config: Pick<Env, "XOS_API_HOST">): string {
  return `${requestOrigin(request)}${onApiHost(request, config) ? "/mcp" : "/api/mcp"}`;
}
