// Integration worker (A83, RRR-128; finding A65-013): one pass of the integration runtime. It runs the Section 17
// connectors' sync runs (integration.sync), processes the inbound webhooks integration-inbound recorded
// (integration.inbound: Slack unfurls and change notices, with retries and a dead letter state) and runs warehouse
// deliveries (warehouse.deliver, Enterprise). Called every minute with the service key, like webhook-dispatch:
// select cron.schedule('xos_worker_integration', '* * * * *', ...) as the self-hosting guide shows.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY (provided by Supabase),
// XOS_API_JWT_SIGNING_KEY (the project's JWT secret, for the one-minute sessions Slack unfurls read records with)
// and XOS_APP_URL (Atlas, whose record links are unfurled). Optional (B16, ADR 0155 D5): XOS_GOOGLE_STORAGE_CLIENT_ID
// and XOS_GOOGLE_STORAGE_CLIENT_SECRET, XOS_MICROSOFT_STORAGE_CLIENT_ID and XOS_MICROSOFT_STORAGE_CLIENT_SECRET, the
// platform OAuth apps that renew Google Drive and OneDrive sign-ins; a connection of a provider not set up keeps its
// token until it expires.
import { createClient } from "@supabase/supabase-js";
import {
  asDbClient,
  httpFromFetch,
  integrationsTranslator,
  mintChatSession,
  runIntegrationRuntime,
  supabaseCommunicationSource,
} from "../_vendor/integration-worker.js";
import { env, hasBearer, json, serve } from "../_shared/runtime.ts";

/** A platform OAuth app's client pair from the function's secrets, or null when it is not set up. */
function oauthPair(prefix: string): { clientId: string; clientSecret: string } | null {
  const clientId = Deno.env.get(`${prefix}_CLIENT_ID`);
  const clientSecret = Deno.env.get(`${prefix}_CLIENT_SECRET`);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

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
      storageOAuth: {
        google_drive: oauthPair("XOS_GOOGLE_STORAGE"),
        onedrive_sharepoint: oauthPair("XOS_MICROSOFT_STORAGE"),
      },
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
