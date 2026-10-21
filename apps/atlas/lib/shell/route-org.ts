/**
 * The request header the proxy sets to the org the route names (`/{org}/...`), and removes from every other
 * request, so server code that renders before the page knows its params (locale negotiation in
 * i18n/request.ts) can apply that org's settings. A value a client sends is never trusted: the proxy
 * replaces it, and the org is looked up again through the viewer's own membership.
 */
export const ROUTE_ORG_HEADER = "x-xos-route-org";
