/**
 * Route templates for browser error reports, most specific first: the reporter replaces the
 * matched part of the path with the template, so an advance or signing token, a handle or a record
 * key never leaves the browser. Mirrors the dynamic segments under app/ (route groups do not
 * appear in the URL). Client-safe: imported by instrumentation-client.ts.
 */
export const CLIENT_ERROR_ROUTES: readonly string[] = [
  "/advance/[token]",
  "/sign/[token]",
  "/u/[handle]",
  "/c/[companyHandle]",
  "/messages/[threadKey]",
  "/explore/[opportunityKey]",
  "/work/engagements/[engagementKey]",
];
