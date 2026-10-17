/**
 * /api/v1/*: the public API (Section 10.1, ADR 0003). Every method is served by the Hono app from
 * `@xos/api`, which mounts only operations that have handlers; the rest answer 404. Callers
 * authenticate with a Supabase session JWT, the Atlas session cookie or an API key, and every query
 * runs as the caller so RLS decides access. `/api/v1/openapi.json` keeps its own static route.
 *
 * `observe` (ADR 0025) continues the caller's trace, opens a server span, writes one redacted
 * completion record per request and echoes `traceparent` and `x-request-id`. An error the Hono app
 * turns into a 500 problem is reported through `onError`, once, with its request id.
 */
import { createApiApp, createSupabaseAuthenticator } from "@xos/api";
import { observe } from "@xos/infra/observability";
import { env } from "@/lib/env";
import { flushErrors, observability } from "@/lib/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ApiApp = ReturnType<typeof createApiApp>;

let app: ApiApp | undefined;

function api(): ApiApp {
  if (app === undefined) {
    const config = env();
    app = createApiApp({
      basePath: "/api/v1",
      authenticate: createSupabaseAuthenticator({
        url: config.SUPABASE_URL,
        anonKey: config.SUPABASE_ANON_KEY,
        siteOrigin: config.ATLAS_SITE_URL,
      }),
      onError: (error, requestId) => {
        observability.errors.report(error, {
          tags: { route: "/api/v1", source: "api" },
          extra: { request_id: requestId },
        });
      },
    });
  }
  return app;
}

const handle = observe(
  async (request) => {
    const response = await api().fetch(request);
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
