/**
 * The request header the proxy sets to the org the route names (`/{org}/...`), so server code that renders
 * before the page knows its params (locale negotiation in i18n/request.ts) can apply that org's settings. The
 * proxy runs on every page request, prefetches included: it replaces a value a client sends, and removes it
 * from a route that names no org. The requests the proxy never sees, the /api/ route handlers, the calendar
 * feeds (/ical/), the OAuth token endpoint and static files, never negotiate a locale, so nothing reads the
 * header there (test/route-org-header.test.ts holds
 * both). The org is still looked up through the viewer's own membership.
 */
export const ROUTE_ORG_HEADER = "x-xos-route-org";
