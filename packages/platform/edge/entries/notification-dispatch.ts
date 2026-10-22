/**
 * notification-dispatch: email, push (Expo devices and, with A96's 1533, browsers through Web Push) and SMS
 * deliveries. React Email, the templates and Resend load only when an email is rendered or sent (@xos/email), so a
 * run with nothing due stays light. Web Push needs no dependency: Web Crypto only.
 */
export { createTransport, readEmailEnv } from "@xos/email/env";
export { dispatchEmail } from "../../src/notifications/dispatch.ts";
export {
  checkPushReceipts,
  createPushClient,
  dispatchPush,
  readPushEnv,
} from "../../src/notifications/push.ts";
export {
  createSmsProvider,
  dispatchSms,
  dispatchSmsSummaries,
  readSmsEnv,
} from "../../src/notifications/sms.ts";
export { createWebPushClient, readWebPushEnv } from "../../src/notifications/web-push.ts";
export { pushStore, smsStore, webPushStore } from "../../src/notifications/stores.ts";
export { notificationStore } from "../../src/stores.ts";
