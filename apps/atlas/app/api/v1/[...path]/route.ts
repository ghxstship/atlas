/**
 * /api/v1/*: the public API (Section 10.1, ADR 0003). Every method is served by the Hono app from
 * `@xos/api`, which mounts only operations that have handlers; the rest answer 404. Callers
 * authenticate with a Supabase session JWT, the Atlas session cookie or an API key, and every query
 * runs as the caller so RLS decides access. `/api/v1/openapi.json` keeps its own static route.
 */
import { createApiApp, createSupabaseAuthenticator } from "@xos/api";
import { env } from "@/lib/env";

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
        console.error(
          JSON.stringify({
            level: "error",
            source: "api",
            requestId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    });
  }
  return app;
}

function handle(request: Request): Response | Promise<Response> {
  return api().fetch(request);
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
