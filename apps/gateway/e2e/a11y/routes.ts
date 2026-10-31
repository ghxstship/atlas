import { toDisplayKey } from "@xos/data/gateway-keys";
import { fillRoute, flattenRoutes, isNodeVisible } from "@xos/ia";
import { sitemap } from "../../ia/sitemap.generated";
import type { PEOPLE } from "./roles";

/**
 * The Gateway routes the A23 sweep visits, shared with the pseudo-locale suite of every route
 * (e2e/pseudo-locales-routes.spec.ts) so both cover the same pages: every sitemap route each
 * external person may open (standing and engagement role type, Section 4.5.8), the public profile
 * pages, and both token flows.
 */
const SHARED_PARAMS: Readonly<Record<string, string>> = {
  handle: "demo-crew",
  companyHandle: "demo-productions",
};

/**
 * Rows each person can see in the seed: the published opportunity is invited to the crew member and
 * the seeded thread sits on the crew engagement. The vendor has neither, so its opportunity detail
 * and thread routes are left to the manual audit.
 */
const PERSON_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  crew: {
    opportunityKey: toDisplayKey("opportunity", "01920000-0000-7000-8000-000000228101"),
    threadKey: toDisplayKey("thread", "01920000-0000-7000-8000-000000227002"),
  },
  vendor: {},
};

const sessionRoutes = flattenRoutes(sitemap).filter((r) => r.auth === "session");

export type Person = (typeof PEOPLE)[number];

/** The sitemap routes a person may open, with their paths. */
export function sweepRoutesFor(person: Person): { id: string; path: string }[] {
  const ctx = {
    role: person.standing,
    roleType: person.roleType,
    // Both sweep people are paid (crew and vendor), so the paid-work pages are theirs (A59-033).
    conditions: ["desktop" as const, "paid-work" as const],
  };
  const params = {
    ...SHARED_PARAMS,
    ...PERSON_PARAMS[person.person],
    engagementKey: person.engagementKey,
  };
  return sessionRoutes
    .filter((r) => isNodeVisible(sitemap, r.id, ctx) && r.params.every((p) => p in params))
    .map((r) => ({ id: r.id, path: fillRoute(r.route, params) }));
}

/** Pages anyone may open: sign in, sign up and the public profiles. No session. */
export const PUBLIC_PAGES: readonly string[] = [
  "/auth/sign-in",
  "/auth/sign-up",
  "/u/demo-crew",
  "/c/demo-productions",
];
