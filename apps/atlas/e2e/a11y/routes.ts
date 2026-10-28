import { fillRoute, flattenRoutes, isNodeVisible } from "@xos/ia";
import { DELEGATED } from "../../ia/routes.config";
import { sitemap } from "../../ia/sitemap.generated";
import { DEMO_ORG, type SweepRole } from "./roles";

/**
 * The Atlas routes the A23 sweep visits, shared with the pseudo-locale suite of every route
 * (e2e/pseudo-locales-routes.spec.ts) so both cover the same pages. Seeded rows fill the data
 * params: project NWS and its record NWS-1, and the Manager's saved view. Custom objects have no
 * seeded type, so `/{org}/objects/{objectKey}` is left to the manual audit.
 */
export const PARAMS: Readonly<Record<string, string>> = {
  org: DEMO_ORG,
  projectKey: "NWS",
  recordKey: "NWS-1",
  viewId: "01920000-0000-7000-8000-000002310003",
};

/** Signed-in sitemap routes Atlas serves itself whose params the seed fills. */
export const SWEEP_ROUTES = flattenRoutes(sitemap).filter(
  (r) =>
    r.auth === "session" &&
    r.servedBy === undefined &&
    !(r.id in DELEGATED) &&
    r.params.every((p) => p in PARAMS),
);

export type SweepRoute = (typeof SWEEP_ROUTES)[number];

/** The sweep routes a role may open on a desktop (Section 4.5.9 visibility), with their paths. */
export function sweepRoutesFor(role: SweepRole): { route: SweepRoute; path: string }[] {
  const ctx = { role, conditions: ["desktop" as const] };
  return SWEEP_ROUTES.filter((r) => isNodeVisible(sitemap, r.id, ctx)).map((route) => ({
    route,
    path: fillRoute(route.route, PARAMS),
  }));
}

/** Whether a route is visible on a phone too; desktop-only nodes answer 404 there by design. */
export function visibleOnPhone(route: SweepRoute, role: SweepRole): boolean {
  return isNodeVisible(sitemap, route.id, { role });
}

/**
 * A 404 on a route with a data param: the role cannot see the seeded row (the Manager's private
 * view, projects outside a Viewer's reach). Data access, not page access, so nothing to audit.
 */
export function noAccess(route: SweepRoute, status: number): boolean {
  return status === 404 && route.params.some((p) => p !== "org");
}

/**
 * Pages anyone may open: the Auth template (sign in, sign up) and public legal documents, which
 * the sitemap marks `auth: public`. No session.
 */
export const PUBLIC_PAGES: readonly string[] = [
  "/auth/sign-in",
  "/auth/sign-up",
  "/legal/accessibility-statement",
  "/legal/privacy-policy",
];

/**
 * The page the proxy sends a member to when an org's IP allow-list refuses their network (A52). It
 * sits outside the sitemap; the Owner sees the emergency access form, the Field role only the
 * explanation, so the sweep visits it as both.
 */
export const NETWORK_RESTRICTED = {
  path: `/auth/network-restricted?org=${DEMO_ORG}`,
  roles: ["owner", "field"] as readonly SweepRole[],
};
