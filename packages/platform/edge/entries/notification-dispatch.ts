/**
 * notification-dispatch: email, push and SMS deliveries. React Email, the templates and Resend load
 * only when an email is rendered or sent (@xos/email), so a run with nothing due stays light.
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
export { pushStore, smsStore } from "../../src/notifications/stores.ts";
export { notificationStore } from "../../src/stores.ts";
