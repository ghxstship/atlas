/**
 * org-lifecycle (A79): deletion certificates and custom domain jobs. The certificate renderer with pdfkit and
 * its fonts, and Resend, load only when a certificate is rendered or sent. It also retries Stripe cancels and sends
 * billing alerts (ADR 0156); the Stripe SDK loads only when a cancel is due.
 */
export * from "../lifecycle.ts";
export {
  mailpitMailer,
  resendMailer,
  type ReportMailer,
} from "../../../data/src/report-deliveries.ts";
export { lazyResendClient, readEmailEnv } from "@xos/email/env";
export { recipientAllowed } from "@xos/email/transport";
export {
  billingLivemode,
  createStripeClient,
  readBillingEnv,
} from "../../src/billing/env.ts";
export { runStripeCancellations, type BillingAlert } from "../../src/billing/cancel.ts";
export { stripeCancellationStore } from "../../src/stores.ts";
