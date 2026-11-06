/**
 * guest-email (B8): the org guest list email worker. React Email, the templates, Resend and, for a Pass email, the
 * guest-pass renderer with pdfkit load only when an email is rendered or sent (@xos/email, edge/guest-email.ts).
 */
export { dispatchGuestEmails, guestEmailStore, guestPassRenderer } from "../guest-email.ts";
export { createTransport, readEmailEnv } from "@xos/email/env";
