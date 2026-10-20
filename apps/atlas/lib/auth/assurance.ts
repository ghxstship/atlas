import type { OrgAuthDecision, RelyingParty } from "@xos/data/auth-assurance";
import { safeNext } from "./redirect";

/**
 * Where Atlas sends a session that owes something before it goes on (Section 9, A77):
 *   - a person who holds a second factor verifies it after the first factor, on /auth/mfa;
 *   - an org whose security.mfa_policy asks a second factor of the person's role sends them to verify, or to
 *     set one up, before any of its pages;
 *   - an org whose security.session_hours or security.idle_timeout_minutes has run out asks them to sign in again.
 * The proxy applies these before every page and server action; the pages repeat nothing because the proxy runs
 * for every route outside /api, and the API runtime checks the org policy on its own.
 */

export const MFA_PATH = "/auth/mfa";
export const SESSION_ENDED_PATH = "/auth/session-ended";

/** The device's last request, for the org idle timeout: an httpOnly epoch-milliseconds cookie. */
export const LAST_SEEN_COOKIE = "xos-last-seen";

/** Paths a session that owes a second factor may still open: signing in or out, and the auth returns. */
const OPEN_PATHS = new Set([
  MFA_PATH,
  SESSION_ENDED_PATH,
  "/auth/sign-in",
  "/auth/sign-up",
  "/auth/sign-out",
  "/auth/callback",
  "/auth/confirm",
  "/auth/check-email",
  "/auth/session",
  "/auth/sso",
  "/auth/not-found",
]);

export function opensWithoutSecondFactor(path: string): boolean {
  return OPEN_PATHS.has(path) || path.startsWith("/legal/") || path === "/legal";
}

function nextOf(path: string, search: string): string {
  return encodeURIComponent(safeNext(`${path}${search}`));
}

/** The second-factor page for a request, carrying where to return. */
export function secondFactorRedirect(path: string, search: string, org?: string): string {
  const query = `next=${nextOf(path, search)}${org ? `&org=${encodeURIComponent(org)}` : ""}`;
  return `${MFA_PATH}?${query}`;
}

/** Where an org's decision sends the request, or null to let it through. */
export function orgAuthRedirect(
  decision: OrgAuthDecision,
  org: string,
  path: string,
  search: string,
): string | null {
  if (decision === "ok") return null;
  if (decision === "mfa") return secondFactorRedirect(path, search, org);
  const reason = decision === "idle" ? "idle" : "lifetime";
  return `${SESSION_ENDED_PATH}?org=${encodeURIComponent(org)}&reason=${reason}&next=${nextOf(path, search)}`;
}

/** The epoch milliseconds in a last-seen cookie, or null when absent or malformed. */
export function parseLastSeen(value: string | undefined): number | null {
  if (value === undefined || !/^\d{10,14}$/.test(value)) return null;
  return Number(value);
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
