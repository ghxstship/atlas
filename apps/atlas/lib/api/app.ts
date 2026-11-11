import "server-only";
import { createApiApp, createSupabaseAuthenticator, handlersWithAuroraModel } from "@xos/api";
import { trustedProxyHops } from "@xos/data/client-address";
import { API_HOST_PREFIX } from "@/lib/api-host";
import { env } from "@/lib/env";
import { observability } from "@/lib/observability";

/**
 * The public API's Hono app (Section 10.1, ADR 0003), built once per server process and shared by the /api/v1 route
 * and the hosted MCP endpoint (B16), which calls it in process with the connected app's token. It mounts only
 * operations that have handlers; the rest answer 404. Callers authenticate with a Supabase session JWT, the Atlas
 * session cookie or an API key, and every query runs as the caller so RLS decides access.
 */

export type ApiApp = ReturnType<typeof createApiApp>;

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

/** The API app, created on first use. */
export async function apiApp(): Promise<ApiApp> {
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
