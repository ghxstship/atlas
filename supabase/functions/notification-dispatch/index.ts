// Notification worker, called every minute by pg_cron with the service key. Each run sends due email, push
// and SMS deliveries, then reads due push receipts (finding A65-012).
//   * Email through @xos/email. Without XOS_EMAIL_TRANSPORT=resend it records instead of sending; with Resend,
//     recipients outside XOS_EMAIL_ALLOWLIST are refused unless XOS_EMAIL_DELIVER_TO_ANY=true (production only,
//     Section 19.8).
//   * Push through the Expo push service when XOS_PUSH_TRANSPORT=expo (EXPO_ACCESS_TOKEN when the Expo project
//     uses enhanced push security); recorded otherwise. Receipts prune devices Expo no longer knows.
//   * SMS through Twilio when XOS_SMS_TRANSPORT=twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
//     TWILIO_MESSAGING_SERVICE_SID, XOS_SMS_HELP_CONTACT), limited to XOS_SMS_ALLOWLIST unless
//     XOS_SMS_DELIVER_TO_ANY=true; recorded otherwise. Twilio posts delivery status to sms-webhook. Texts held by
//     quiet hours go out as one summary per member and org when the quiet hours end (ADR 0033 decision 35).
// One channel failing never stops the others: its error is logged and reported in the answer.
import {
  checkPushReceipts,
  createLogger,
  createPushClient,
  createSmsProvider,
  createTransport,
  dispatchEmail,
  dispatchPush,
  dispatchSms,
  dispatchSmsSummaries,
  identityFromEnv,
  notificationStore,
  pushStore,
  readEmailEnv,
  readPushEnv,
  readSmsEnv,
  smsStore,
} from "../_vendor/xos-platform.js";
import { env, hasBearer, json, serve, serviceDb } from "../_shared/runtime.ts";

const logger = createLogger(identityFromEnv("edge.notification-dispatch", Deno.env.toObject()));

async function channel<T>(name: string, run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("A notification channel failed.", { channel: name, error: message });
    return { error: message };
  }
}

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const source = Deno.env.toObject();
  const db = serviceDb();
  const functionsUrl = `${env("SUPABASE_URL")}/functions/v1`;
  const appUrl = env("XOS_APP_URL");

  const email = await channel("email", async () => {
    const emailEnv = readEmailEnv(source);
    const store = notificationStore(db, {
      appUrl,
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
      // External parties' notifications (1131) link to Gateway.
      gatewayUrl: Deno.env.get("XOS_GATEWAY_URL") ?? null,
    });
    return dispatchEmail(store, createTransport(emailEnv));
  });

  const push = await channel("push", () =>
    dispatchPush(pushStore(db), createPushClient(readPushEnv(source))),
  );
  const receipts = await channel("push-receipts", () =>
    checkPushReceipts(pushStore(db), createPushClient(readPushEnv(source))),
  );

  const smsProvider = () =>
    createSmsProvider(readSmsEnv(source), {
      statusCallbackUrl: Deno.env.get("XOS_SMS_WEBHOOK_URL") ?? `${functionsUrl}/sms-webhook`,
    });
  const sms = await channel("sms", () => dispatchSms(smsStore(db, { appUrl }), smsProvider()));
  // Texts held by quiet hours go out as one summary per member and org when the quiet hours end.
  const smsSummaries = await channel("sms-summaries", () =>
    dispatchSmsSummaries(smsStore(db, { appUrl }), smsProvider()),
  );

  return json(200, { email, push, receipts, sms, smsSummaries });
});
