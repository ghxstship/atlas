import { protectedResourceMetadata } from "@/lib/mcp/metadata";

/** OAuth protected-resource metadata of the hosted MCP endpoint (RFC 9728; B16, ADR 0155 D1). */
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return protectedResourceMetadata(request);
}
