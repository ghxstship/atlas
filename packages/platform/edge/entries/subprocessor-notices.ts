/**
 * subprocessor-notices (A82): the platform email worker for Subprocessor List confirmations and notices.
 * React Email, the templates and Resend load only when an email is rendered or sent (@xos/email).
 */
export { dispatchPlatformEmails, platformEmailStore } from "../../src/legal/platform-emails.ts";
export { createTransport, readEmailEnv } from "@xos/email/env";
