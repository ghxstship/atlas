// Integration worker (A83, RRR-128; finding A65-013): one pass of the integration runtime. It runs the Section 17
// connectors' sync runs (integration.sync), processes the inbound webhooks integration-inbound recorded
// (integration.inbound: Slack unfurls and change notices, with retries and a dead letter state) and runs warehouse
// deliveries (warehouse.deliver, Enterprise). Called every minute with the service key, like webhook-dispatch:
// select cron.schedule('xos_worker_integration', '* * * * *', ...) as the self-hosting guide shows.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY (provided by Supabase),
// XOS_API_JWT_SIGNING_KEY (the project's JWT secret, for the one-minute sessions Slack unfurls read records with)
// and XOS_APP_URL (Atlas, whose record links are unfurled).
import { createClient } from "@supabase/supabase-js";
import {
  asDbClient,
  httpFromFetch,
  integrationsTranslator,
  mintChatSession,
  runIntegrationRuntime,
  supabaseCommunicationSource,
} from "../_vendor/xos-platform.js";
import { env, hasBearer, json, serve } from "../_shared/runtime.ts";

serve(async (request) => {
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!hasBearer(request, serviceKey)) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const url = env("SUPABASE_URL");
  const service = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const db = asDbClient(service.schema("app"));
  const signingKey = env("XOS_API_JWT_SIGNING_KEY");
  const anonKey = env("SUPABASE_ANON_KEY");
  const summary = await runIntegrationRuntime(
    {
      db,
      canon: asDbClient(service.schema("xpms")),
      storage: service.storage,
      http: httpFromFetch((input, init) => fetch(input, init)),
      resolve: async (host) => [
        ...(await Deno.resolveDns(host, "A").catch(() => [])),
        ...(await Deno.resolveDns(host, "AAAA").catch(() => [])),
      ],
      translate: integrationsTranslator("en-US"),
      atlasOrigin: new URL(env("XOS_APP_URL")).origin,
      chat: {
        source: supabaseCommunicationSource(db),
        translate: integrationsTranslator("en-US"),
        clientFor: async (userId) => {
          const token = await mintChatSession(userId, signingKey, `${url}/auth/v1`);
          const client = createClient(url, anonKey, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { headers: { Authorization: `Bearer ${token}` } },
          });
          return asDbClient(client.schema("app"));
        },
      },
    },
    `integration-worker:${crypto.randomUUID()}`,
  );
  return json(200, summary);
});
