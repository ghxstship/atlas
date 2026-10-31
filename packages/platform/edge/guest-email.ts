/**
 * The guest-email worker for the Edge bundle (B8, migration 2975, ADR 0147 decision 7): the dispatcher of
 * src/notifications/guest-emails.ts and the A6 guest pass it attaches to a Pass email.
 *
 * Cold starts (A85): the document renderer, with pdfkit, its fonts and the documents copy, loads only when a Pass
 * email is sent. The renderer decodes its embedded fonts with Buffer, which the Edge runtime exposes only to npm
 * packages; the bundle is not one, so it gets Node's first, as the deletion certificate does.
 */
import type { ClaimedGuestEmail, GuestPassFacts } from "../src/notifications/guest-emails.ts";

export {
  dispatchGuestEmails,
  guestEmailStore,
  type GuestEmailSummary,
} from "../src/notifications/guest-emails.ts";

/** A RenderGuestPass for the dispatcher: the guest's pass on A6, in the email's language. */
export function guestPassRenderer(gatewayUrl: string) {
  return async (claim: ClaimedGuestEmail, pass: GuestPassFacts): Promise<Uint8Array> => {
    const scope = globalThis as { Buffer?: unknown };
    if (scope.Buffer === undefined) scope.Buffer = (await import("node:buffer")).Buffer;
    const { renderGuestPassPdf } = await import("./guest-pass-render.ts");
    return renderGuestPassPdf(claim, pass, { gatewayUrl });
  };
}
