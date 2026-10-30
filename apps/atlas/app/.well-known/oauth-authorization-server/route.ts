import { authorizationServerMetadata } from "@/lib/mcp/metadata";

/** OAuth authorization-server metadata (RFC 8414; B16, ADR 0155 D1): /oauth/authorize and /oauth/token. */
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return authorizationServerMetadata(request);
}
