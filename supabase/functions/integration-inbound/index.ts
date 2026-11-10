// Inbound integration webhooks (A83, RRR-128; finding A65-013). Providers post here; every request is verified on
// its raw body before anything is read or recorded (packages/integrations/src/inbound):
//   /integration-inbound/slack/events and /slack/commands   (XOS_SLACK_SIGNING_SECRET)
//   /integration-inbound/microsoft_teams/<connection id>     (the connection's webhook secret, in Vault)
//   /integration-inbound/xero                                (XOS_XERO_WEBHOOK_KEY)
//   /integration-inbound/quickbooks_online                   (XOS_QUICKBOOKS_VERIFIER_TOKEN)
//   /integration-inbound/google_calendar/<connection id>     (the channel token, in Vault)
//   /integration-inbound/microsoft_365/<connection id>       (the subscription client state, in Vault)
// Work that can wait is recorded once per provider event and processed by integration-worker with retries and a
// dead letter state; slash commands and Teams messages are answered at once as the linked person, with a
// one-minute session signed with the project signing key (XOS_API_JWT_SIGNING_KEY, ADR 0168). Providers authenticate by signature, so the function runs
// with verify_jwt = false (supabase/config.toml). An endpoint whose secret is unset answers 503.
import { createClient } from "@supabase/supabase-js";
import {
  asDbClient,
  handleInboundRequest,
  integrationsTranslator,
  mintChatSession,
  supabaseCommunicationSource,
  supabaseInboundStore,
} from "../_vendor/integration-inbound.js";
import { env, secretKey, serve, publishableKey } from "../_shared/runtime.ts";
import { tokenSigner } from "../_shared/sessions.ts";

serve(async (request) => {
  const url = env("SUPABASE_URL");
  const service = createClient(url, secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const db = asDbClient(service.schema("app"));
  const optional = (name: string) => Deno.env.get(name) || undefined;
  return handleInboundRequest(request, {
    store: supabaseInboundStore(db),
    secrets: {
      slackSigningSecret: optional("XOS_SLACK_SIGNING_SECRET"),
      xeroWebhookKey: optional("XOS_XERO_WEBHOOK_KEY"),
      quickbooksVerifierToken: optional("XOS_QUICKBOOKS_VERIFIER_TOKEN"),
    },
    chat: {
      source: supabaseCommunicationSource(db),
      translate: integrationsTranslator("en-US"),
      clientFor: async (userId) => {
        const token = await mintChatSession(userId, tokenSigner(), `${url}/auth/v1`);
        const client = createClient(url, publishableKey(), {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        return asDbClient(client.schema("app"));
      },
    },
  });
});
