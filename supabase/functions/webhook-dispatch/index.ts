// Webhook dispatcher worker: posts due deliveries signed by the database and records each outcome, so the
// database applies the 72-hour exponential backoff. Called on a schedule with the service key.
import { dispatchWebhooks, webhookStore } from "../_vendor/xos-platform.js";
import { env, hasBearer, json, serve, serviceDb } from "../_shared/runtime.ts";

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const summary = await dispatchWebhooks({
    store: webhookStore(serviceDb()),
    fetch: (url, init) => fetch(url, init),
    resolve: async (host) => [
      ...(await Deno.resolveDns(host, "A").catch(() => [])),
      ...(await Deno.resolveDns(host, "AAAA").catch(() => [])),
    ],
  });
  return json(200, summary);
});
