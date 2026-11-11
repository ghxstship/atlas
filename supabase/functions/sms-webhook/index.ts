// sent.dm webhook (owner decision 2026-11-11; Section 14.5 TCPA and 10DLC, finding A65-012): delivery events for the
// texts XOS sends, inbound messages to its numbers, and network-reported opt-outs. Authenticated by sent.dm's
// Standard Webhooks signature (webhook-signature, or x-webhook-signature on version 1 webhooks), keyed with
// SENT_DM_WEBHOOK_SECRET, over the raw body, refused outside a five-minute window. STOP, START and HELP are recorded
// through app.record_sms_keyword (STOP writes the STOP suppression); sent.dm answers them with the auto-replies the
// owner sets. Delivery events go to app.record_sms_status. Register this function's URL as the endpoint in sent.dm,
// subscribed to message and contact events (infra/runbooks/production.md).
import {
  handleSentdmWebhook,
  readSmsEnv,
  sentdmHeaders,
  smsInboundStore,
} from "../_vendor/sms-webhook.js";
import { json, serve, serviceDb } from "../_shared/runtime.ts";

serve(async (request) => {
  if (request.method !== "POST") {
    return json(405, {
      type: "/problems/method-not-allowed",
      title: "Method not allowed",
      status: 405,
    });
  }
  const smsEnv = readSmsEnv(Deno.env.toObject());
  if (smsEnv.SENT_DM_WEBHOOK_SECRET === undefined) {
    return json(503, {
      type: "/problems/sms-not-configured",
      title: "SMS not configured",
      status: 503,
      detail: "Set SENT_DM_WEBHOOK_SECRET to accept sent.dm webhooks.",
    });
  }
  const answer = await handleSentdmWebhook(
    {
      headers: sentdmHeaders((name) => request.headers.get(name)),
      rawBody: await request.text(),
    },
    smsInboundStore(serviceDb()),
    { webhookSecret: smsEnv.SENT_DM_WEBHOOK_SECRET },
  );
  return new Response(answer.status === 204 ? null : answer.body, {
    status: answer.status,
    headers: { "Content-Type": answer.contentType },
  });
});
