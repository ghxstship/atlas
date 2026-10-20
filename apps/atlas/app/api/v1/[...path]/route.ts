/**
 * /api/v1/*: the public API (Section 10.1, ADR 0003). Every method is served by the Hono app from
 * `@xos/api`, which mounts only operations that have handlers; the rest answer 404. Callers
 * authenticate with a Supabase session JWT, the Atlas session cookie or an API key, and every query
 * runs as the caller so RLS decides access. `/api/v1/openapi.json` keeps its own static route. On
 * the API host (XOS_API_HOST) the same route serves `/v1/*` (lib/api-host.ts).
 *
 * `observe` (ADR 0025) continues the caller's trace, opens a server span, writes one redacted
 * completion record per request and echoes `traceparent` and `x-request-id`. An error the Hono app
 * turns into a 500 problem is reported through `onError`, once, with its request id.
 */
import { createApiApp, createSupabaseAuthenticator, handlersWithAuroraModel } from "@xos/api";
import { trustedProxyHops } from "@xos/data/client-address";
import { observe } from "@xos/infra/observability";
import { API_HOST_PREFIX } from "@/lib/api-host";
import { env } from "@/lib/env";
import { flushErrors, observability } from "@/lib/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ApiApp = ReturnType<typeof createApiApp>;

let app: ApiApp | undefined;

/**
 * Aurora's end-to-end fixture model (finding A24-007), outside production only. The literal
 * `process.env.NODE_ENV` test is replaced at build time, so a production build drops this branch
 * and never bundles the fixture; `fixtureModelEnabled` also needs XOS_AI_FAKE=1 at run time.
 */
async function fixtureHandlers() {
  if (process.env.NODE_ENV === "production") return undefined;
  const { createFixtureModel, fixtureModelEnabled } = await import("@/lib/aurora/fixture-model");
  if (!fixtureModelEnabled()) return undefined;
  const model = createFixtureModel();
  return handlersWithAuroraModel(() => model);
}

const handlers = fixtureHandlers();

async function api(): Promise<ApiApp> {
  if (app === undefined) {
    const config = env();
    const fixture = await handlers;
    app = createApiApp({
      ...(fixture ? { handlers: fixture } : {}),
      // `/v1` is the API host's prefix: the proxy rewrites it here and the path stays as sent.
      basePath: ["/api/v1", API_HOST_PREFIX],
      authenticate: createSupabaseAuthenticator({
        url: config.SUPABASE_URL,
        anonKey: config.SUPABASE_ANON_KEY,
        siteOrigin: config.ATLAS_SITE_URL,
        trustedProxyHops: trustedProxyHops(config.XOS_TRUSTED_PROXY_HOPS),
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
    const response = await (await api()).fetch(request);
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
