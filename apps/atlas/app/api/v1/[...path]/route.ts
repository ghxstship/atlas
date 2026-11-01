/**
 * /api/v1/*: the public API (Section 10.1, ADR 0003). Every method is served by the Hono app from
 * `@xos/api` (lib/api/app.ts, shared with the hosted MCP endpoint), which mounts only operations that
 * have handlers; the rest answer 404. Callers authenticate with a Supabase session JWT, the Atlas
 * session cookie or an API key, and every query runs as the caller so RLS decides access.
 * `/api/v1/openapi.json` keeps its own static route. On the API host (XOS_API_HOST) the same route
 * serves `/v1/*` (lib/api-host.ts).
 *
 * `observe` (ADR 0025) continues the caller's trace, opens a server span, writes one redacted
 * completion record per request and echoes `traceparent` and `x-request-id`. An error the Hono app
 * turns into a 500 problem is reported through `onError`, once, with its request id.
 */
import { observe } from "@xos/infra/observability";
import { apiApp } from "@/lib/api/app";
import { flushErrors, observability } from "@/lib/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handle = observe(
  async (request) => {
    const response = await (await apiApp()).fetch(request);
    if (response.status >= 500) await flushErrors();
    return response;
  },
  { ...observability, route: "/api/v1" },
);

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
