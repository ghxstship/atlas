// Platform email worker (A82, RRR-127; Section 14.4, migration 1382): sends the double opt-in confirmations
// for Subprocessor List change notices and the notices themselves from private.platform_emails, each in the
// recipient's language with its own unsubscribe link, then records the outcome so the outbox forgets the
// token. Without XOS_EMAIL_TRANSPORT=resend it records instead of sending; with Resend, recipients outside
// XOS_EMAIL_ALLOWLIST are refused unless XOS_EMAIL_DELIVER_TO_ANY=true (production only, Section 19.8).
// Called on a schedule with the service key, like notification-dispatch.
import {
  createTransport,
  dispatchPlatformEmails,
  platformEmailStore,
  readEmailEnv,
} from "../_vendor/xos-platform.js";
import { env, hasBearer, json, serve, serviceDb } from "../_shared/runtime.ts";

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const emailEnv = readEmailEnv(Deno.env.toObject());
  const summary = await dispatchPlatformEmails(
    platformEmailStore(serviceDb()),
    createTransport(emailEnv),
    {
      appUrl: env("XOS_APP_URL"),
      from: emailEnv.XOS_EMAIL_FROM,
      postalAddress: env("XOS_POSTAL_ADDRESS"),
      senderName: "XOS",
    },
  );
  return json(200, summary);
});
