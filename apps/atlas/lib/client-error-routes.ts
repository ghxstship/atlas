/**
 * Route templates for browser error reports, most specific first: the reporter replaces the
 * matched part of the path with the template, so an org slug, project key, record key or invite
 * token never leaves the browser. Mirrors the dynamic segments under app/. Client-safe: imported
 * by instrumentation-client.ts.
 */
export const CLIENT_ERROR_ROUTES: readonly string[] = [
  "/auth/invite/[token]",
  "/auth",
  "/api",
  "/legal/[document]",
  "/partner/[partnerSlug]",
  "/[org]/p/[projectKey]",
  "/[org]/r/[recordKey]",
  "/[org]/objects/[objectKey]",
  "/[org]/views/[viewId]",
  "/[org]",
];
