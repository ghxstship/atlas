// Guest list email worker (B8, RRR-232; gap G-71, migration 2975, ADR 0147 decision 7): sends the emails staff queued
// to a project's guests, from app.guest_emails, each in the send's language with the org's name as the sender, the
// one-click unsubscribe headers of its row and XOS_POSTAL_ADDRESS (decision 41). A Pass email carries the guest's A6
// pass as a PDF. Without XOS_EMAIL_TRANSPORT=resend it records instead of sending; with Resend, recipients outside
// XOS_EMAIL_ALLOWLIST are refused unless XOS_EMAIL_DELIVER_TO_ANY=true (production only, Section 19.8). Called by
// pg_cron every minute while emails are Queued (private.request_guest_email_send), with the service key.
import {
  createTransport,
  dispatchGuestEmails,
  guestEmailStore,
  guestPassRenderer,
  readEmailEnv,
} from "../_vendor/guest-email.js";
import { env, hasBearer, json, serve, serviceDb } from "../_shared/runtime.ts";

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const emailEnv = readEmailEnv(Deno.env.toObject());
  const gatewayUrl = env("XOS_GATEWAY_URL");
  const summary = await dispatchGuestEmails(
    guestEmailStore(serviceDb()),
    createTransport(emailEnv),
    guestPassRenderer(gatewayUrl),
    {
      unsubscribeUrl: `${env("SUPABASE_URL").replace(/\/+$/, "")}/functions/v1/email-unsubscribe`,
      gatewayUrl,
      fromAddress: emailEnv.XOS_EMAIL_FROM,
      postalAddress: env("XOS_POSTAL_ADDRESS"),
    },
  );
  return json(200, summary);
});
