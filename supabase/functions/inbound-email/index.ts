// Inbound mail endpoint (Section 4.6.5): the mail provider posts each parsed message, with its DKIM result,
// authenticated by XOS_INBOUND_SECRET. Project inbox mail is filed; replies are accepted only from signed
// addresses, with DKIM passing and quoted text stripped.
import { z } from "zod";
import { inboundStore, receiveInbound } from "../_vendor/inbound-email.js";
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

serve(async (request) => {
  if (request.method !== "POST")
    return json(405, {
      type: "/problems/method-not-allowed",
      title: "Method not allowed",
      status: 405,
    });
  if (!hasBearer(request, env("XOS_INBOUND_SECRET")))
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
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
