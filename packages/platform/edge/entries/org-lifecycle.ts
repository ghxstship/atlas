/**
 * org-lifecycle (A79): deletion certificates and custom domain jobs. The certificate renderer with pdfkit and
 * its fonts, and Resend, load only when a certificate is rendered or sent.
 */
export * from "../lifecycle.ts";
export {
  mailpitMailer,
  resendMailer,
  type ReportMailer,
} from "../../../data/src/report-deliveries.ts";
export { lazyResendClient, readEmailEnv } from "@xos/email/env";
export { recipientAllowed } from "@xos/email/transport";
