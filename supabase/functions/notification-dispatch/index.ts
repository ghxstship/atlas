// Notification email worker: sends due email deliveries through @xos/email. Without XOS_EMAIL_TRANSPORT=resend
// it records instead of sending; with Resend, recipients outside XOS_EMAIL_ALLOWLIST are refused unless
// XOS_EMAIL_DELIVER_TO_ANY=true (production only, Section 19.8). Called on a schedule with the service key.
import {
  createTransport,
  dispatchEmail,
  notificationStore,
  readEmailEnv,
} from "../_vendor/xos-platform.js";
import { env, hasBearer, json, serve, serviceDb } from "../_shared/runtime.ts";

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const emailEnv = readEmailEnv(Deno.env.toObject());
  const db = serviceDb();
  const functionsUrl = `${env("SUPABASE_URL")}/functions/v1`;
  const store = notificationStore(db, {
    appUrl: env("XOS_APP_URL"),
    fromAddress: emailEnv.XOS_EMAIL_FROM.replace(/^.*<([^>]+)>$/, "$1"),
    postalAddress: env("XOS_POSTAL_ADDRESS"),
    unsubscribeUrl: async (orgId, personId) => {
      const token = await db.rpc("unsubscribe_token", {
        p_org_id: orgId,
        p_person_id: personId,
        p_category: "all",
      });
      return `${functionsUrl}/email-unsubscribe?token=${encodeURIComponent(String(token))}`;
    },
    inboundDomain: Deno.env.get("XOS_INBOUND_DOMAIN") ?? null,
  });
  return json(200, await dispatchEmail(store, createTransport(emailEnv)));
});
