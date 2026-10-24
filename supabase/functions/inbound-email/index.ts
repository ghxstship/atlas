// Inbound mail (Section 4.6.5, ADR 0040). Resend's inbound mail (ADR 0033, decision 60) posts events signed with
// RESEND_INBOUND_WEBHOOK_SECRET and read through RESEND_RECEIVING_API_KEY; another provider posts a parsed message
// with XOS_INBOUND_SECRET. Mail that is not for XOS answers 200, so the provider does not retry it.
import { z } from "zod";
import {
  inboundRawReferences,
  inboundStore,
  parseResendEvent,
  receiveInbound,
  receiveResendEmail,
  storageRawMailStore,
  verifyResendSignature,
} from "../_vendor/inbound-email.js";
import { env, hasBearer, json, serve, serviceDb } from "../_shared/runtime.ts";

const payload = z.object({
  to: z.array(z.string()).min(1),
  from: z.string().min(3),
  subject: z.string().default(""),
  messageId: z.string().min(3),
  dkimPass: z.boolean(),
  text: z.string().default(""),
  rawObjectPath: z.string().min(1),
});

const unauthorized = () =>
  json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });

async function fromResend(request: Request): Promise<Response> {
  const secret = Deno.env.get("RESEND_INBOUND_WEBHOOK_SECRET");
  const apiKey = Deno.env.get("RESEND_RECEIVING_API_KEY");
  if (!secret || !apiKey) {
    return json(503, {
      type: "/problems/inbound-not-configured",
      title: "Inbound mail not configured",
      status: 503,
      detail:
        "Set RESEND_INBOUND_WEBHOOK_SECRET and RESEND_RECEIVING_API_KEY to accept Resend's inbound mail.",
    });
  }
  const body = await request.text();
  const signed = await verifyResendSignature(
    {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    },
    body,
    secret,
  );
  if (!signed) return unauthorized();
  const event = parseResendEvent(body);
  if (event === null) {
    return json(422, { type: "/problems/invalid-message", title: "Invalid message", status: 422 });
  }
  const db = serviceDb();
  const outcome = await receiveResendEmail(event, {
    store: inboundStore(db),
    references: inboundRawReferences(db),
    rawMail: storageRawMailStore({
      url: env("SUPABASE_URL"),
      serviceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
    }),
    apiKey,
    inboundDomain: env("XOS_INBOUND_DOMAIN"),
  });
  return outcome.status === "ignored"
    ? json(200, { ignored: outcome.reason })
    : json(200, { inbound_message_id: outcome.inboundMessageId });
}

serve(async (request) => {
  if (request.method !== "POST")
    return json(405, {
      type: "/problems/method-not-allowed",
      title: "Method not allowed",
      status: 405,
    });
  if (request.headers.has("svix-signature")) return fromResend(request);
  const secret = Deno.env.get("XOS_INBOUND_SECRET");
  if (!secret || !hasBearer(request, secret)) return unauthorized();
  const parsed = payload.safeParse(await request.json());
  if (!parsed.success) {
    return json(422, {
      type: "/problems/invalid-message",
      title: "Invalid message",
      status: 422,
      detail: parsed.error.message,
    });
  }
  const id = await receiveInbound(
    inboundStore(serviceDb()),
    parsed.data,
    env("XOS_INBOUND_DOMAIN"),
  );
  return json(200, { inbound_message_id: id });
});
