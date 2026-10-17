/**
 * Routes outside the Gateway sitemap that the shell owns: the entry redirect, the Auth template
 * flows under /auth (ADR 0017 item 2: sign-in pages are not navigation), the account claim after a
 * token flow (Section 4.4.6), and the public ranking explanation Section 4.4.3 requires. Patterns
 * use the sitemap's `{param}` syntax. Every other route file belongs to a sitemap node (gate 23).
 */
export const SHELL_ROUTES: Readonly<Record<string, string>> = {
  "/": "Entry: sends a signed-in person to Home, everyone else to sign in.",
  "/auth/sign-in": "Auth template: magic link, OAuth and password sign-in.",
  "/auth/sign-up": "Auth template: account creation.",
  "/auth/check-email": "Auth template: magic link and confirmation sent.",
  "/auth/callback": "Route handler: OAuth and PKCE code exchange.",
  "/auth/confirm": "Route handler: email link token verification.",
  "/auth/sign-out": "Route handler: ends the session (POST only).",
  "/auth/session": "Route handler: session expiry for the re-authentication dialog.",
  "/auth/claim": "Auth template: claim token submissions into the signed-in account.",
  "/explore/how-ranking-works": "Public page: the marketplace ranking factors (Section 4.4.3).",
  "/api/client-errors": "Route handler: browser error reports, forwarded to Sentry (ADR 0025).",
};
