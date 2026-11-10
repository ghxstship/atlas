/** What the guest-email function loads on a request, in one chunk, so its boot stays inside its budget (B8). */
export { dispatchGuestEmails, guestEmailStore, guestPassRenderer } from "./guest-email.ts";
export { createTransport, readEmailEnv } from "@xos/email/env";
