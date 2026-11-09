/**
 * guest-email (B8): the org guest list email worker. React Email, the templates, Resend and, for a Pass email, the
 * guest-pass renderer with pdfkit, and the worker itself, load only when an email is rendered or sent (@xos/email, edge/guest-email.ts).
 */
export const loadGuestEmail = () => import("../guest-email-worker.ts");
