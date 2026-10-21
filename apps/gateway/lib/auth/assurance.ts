import type { RelyingParty } from "@xos/data/auth-assurance";
import { safeNext } from "./redirect";

/**
 * Gateway's second factor (Section 9, A77): a person who holds a verified second factor verifies it after the
 * first factor, on /auth/mfa, before any page that needs a session. It is the same sign-in Atlas and Compass use.
 * Org security settings (MFA by role, session lifetime) govern org roles in Atlas; Gateway serves external parties,
 * whose access comes from their engagements.
 */

export const MFA_PATH = "/auth/mfa";

/**
 * The second-factor page for a request, carrying where to return. The proxy applies it to the sitemap routes
 * that need a session; the auth pages themselves sit outside the sitemap and stay open.
 */
export function secondFactorRedirect(path: string, search: string): string {
  return `${MFA_PATH}?next=${encodeURIComponent(safeNext(`${path}${search}`, "/home"))}`;
}

/**
 * The WebAuthn relying party for security keys as a second factor, from WEBAUTHN_RP_ID and WEBAUTHN_RP_ORIGINS
 * (the values of Supabase Auth's [auth.webauthn]), or null when they are not set.
 */
export function relyingPartyFrom(source: {
  readonly WEBAUTHN_RP_ID?: string | undefined;
  readonly WEBAUTHN_RP_ORIGINS?: string | undefined;
}): RelyingParty | null {
  const id = source.WEBAUTHN_RP_ID?.trim();
  const origins = (source.WEBAUTHN_RP_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => /^https?:\/\/[^/\s]+$/.test(o));
  return id && origins.length > 0 ? { id, origins } : null;
}
