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
  "/auth/terms": "Auth template: the Worker Terms for an account a sign-in provider created.",
  "/explore/how-ranking-works": "Public page: the marketplace ranking factors (Section 4.4.3).",
  "/legal/{document}":
    "Public page: the Worker Terms and Privacy Policy that sign-up names (Section 14.4).",
  "/documents/{kind}/{id}":
    "Route handler: a generated document as tagged PDF/UA for an external party (ADR 0031).",
  "/api/client-errors": "Route handler: browser error reports, forwarded to Sentry (ADR 0025).",
  "/ical/{feedFile}":
    "Route handler: a calendar subscription feed, <token>.ics only (Section 4.5.8, Section 4.6.5, ADR 0040).",
  "/.well-known/apple-app-site-association":
    "Route handler: universal links to Compass for Continue on another device (ADR 0030).",
  "/.well-known/assetlinks.json":
    "Route handler: Android App Links to Compass for Continue on another device (ADR 0030).",
};
