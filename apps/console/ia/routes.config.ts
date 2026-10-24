/**
 * Routes outside the console sitemap that the shell owns: the entry redirect and the auth flows under /auth (sign-in
 * pages are not navigation, ADR 0017 item 2). Patterns use the sitemap's `{param}` syntax. Every other route file
 * belongs to a sitemap node (test/routes.test.ts).
 */
export const SHELL_ROUTES: Readonly<Record<string, string>> = {
  "/": "Entry: sends an operator to tenant search, everyone else to sign in.",
  "/auth/sign-in": "Auth template: Google and, outside production, password sign-in.",
  "/auth/callback": "Route handler: OAuth code exchange; refuses an account off the platform team.",
  "/auth/second-factor":
    "Auth template: set up or verify the authenticator app every operator needs.",
  "/auth/refused": "Route handler: signs out an account off the platform team and says so.",
  "/auth/sign-out": "Route handler: ends the session (POST only).",
};
