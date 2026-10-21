// Twilio webhook (Section 14.5 TCPA and 10DLC, finding A65-012): inbound messages to the Messaging Service and
// delivery status callbacks. Authenticated by Twilio's request signature (X-Twilio-Signature, keyed with
// TWILIO_AUTH_TOKEN) over the public URL Twilio calls: XOS_SMS_WEBHOOK_URL, or this function's URL on
// SUPABASE_URL. STOP, START and HELP are recorded through app.record_sms_keyword (STOP writes the STOP
// suppression) and answered with the catalog's reply; status callbacks go to app.record_sms_status.
import { handleTwilioWebhook, readSmsEnv, smsInboundStore } from "../_vendor/xos-platform.js";
import { env, json, serve, serviceDb } from "../_shared/runtime.ts";

serve(async (request) => {
  if (request.method !== "POST") {
    return json(405, {
      type: "/problems/method-not-allowed",
      title: "Method not allowed",
      status: 405,
    });
  }
  const smsEnv = readSmsEnv(Deno.env.toObject());
  if (smsEnv.TWILIO_AUTH_TOKEN === undefined || smsEnv.XOS_SMS_HELP_CONTACT === undefined) {
    return json(503, {
      type: "/problems/sms-not-configured",
      title: "SMS not configured",
      status: 503,
      detail: "Set TWILIO_AUTH_TOKEN and XOS_SMS_HELP_CONTACT to accept Twilio webhooks.",
    });
  }
  const params = Object.fromEntries(new URLSearchParams(await request.text()));
  const answer = await handleTwilioWebhook(
    {
      url: Deno.env.get("XOS_SMS_WEBHOOK_URL") ?? `${env("SUPABASE_URL")}/functions/v1/sms-webhook`,
      params,
      signature: request.headers.get("X-Twilio-Signature"),
    },
    smsInboundStore(serviceDb()),
    { authToken: smsEnv.TWILIO_AUTH_TOKEN, helpContact: smsEnv.XOS_SMS_HELP_CONTACT },
  );
  return new Response(answer.status === 204 ? null : answer.body, {
    status: answer.status,
    headers: { "Content-Type": answer.contentType },
  });
});
