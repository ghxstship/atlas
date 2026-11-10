/**
 * The guest-email worker for the Edge bundle (B8, migration 6255, ADR 0147 decision 7): the dispatcher of
 * src/notifications/guest-emails.ts and the A6 guest pass it attaches to a Pass email.
 *
 * Cold starts (A85): the document renderer, with pdfkit, its fonts and the documents copy, loads only when a Pass
 * email is sent. The renderer decodes its embedded fonts with Buffer, which the Edge runtime exposes only to npm
 * packages; the bundle is not one, so it gets Node's first, as the deletion certificate does.
 */
import type {
  ClaimedGuestEmail,
  GuestPassBrand,
  GuestPassFacts,
} from "../src/notifications/guest-emails.ts";

import { withoutTrailingSlashes } from "../src/stores.ts";

export {
  dispatchGuestEmails,
  guestEmailStore,
  type GuestEmailSummary,
} from "../src/notifications/guest-emails.ts";

/**
 * A RenderGuestPass for the dispatcher: the guest's pass on A6, in the email's language, with its org's document brand
 * as Atlas prints it. The logo is read from the public org-brand bucket. A logo that is not there is left out, as it
 * would be on every attempt; any other failed read throws, so the row is tried again rather than sent without the
 * logo once: every attempt of a row carries the same bytes under one idempotency key.
 */
export function guestPassRenderer(
  gatewayUrl: string,
  options: { readonly brandAssetUrl?: string | null; readonly fetch?: typeof fetch } = {},
) {
  return async (
    claim: ClaimedGuestEmail,
    pass: GuestPassFacts,
    brand: GuestPassBrand,
  ): Promise<Uint8Array> => {
    const scope = globalThis as { Buffer?: unknown };
    if (scope.Buffer === undefined) scope.Buffer = (await import("node:buffer")).Buffer;
    const { renderGuestPassPdf } = await import("./guest-pass-render.ts");
    const logo = await readLogo(brand.logoPath, options);
    return renderGuestPassPdf(claim, pass, { gatewayUrl, brand, logo });
  };
}

async function readLogo(
  path: string | null,
  options: { readonly brandAssetUrl?: string | null; readonly fetch?: typeof fetch },
): Promise<Uint8Array | null> {
  const base = options.brandAssetUrl ? withoutTrailingSlashes(options.brandAssetUrl) : "";
  if (!path || !base) return null;
  const url = `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const response = await (options.fetch ?? fetch)(url);
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) {
    throw new Error(`The org's logo could not be read for the guest pass (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
