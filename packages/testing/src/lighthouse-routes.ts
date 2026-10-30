import { toDisplayKey } from "@xos/data/gateway-keys";
import { fillRoute, flattenRoutes, isNodeVisible, type NavContext, type Sitemap } from "@xos/ia";
import { sitemap as atlasSitemap } from "../../../apps/atlas/ia/sitemap.generated.ts";
import { sitemap as gatewaySitemap } from "../../../apps/gateway/ia/sitemap.generated.ts";
import { lighthouseTargets, type LighthouseApp } from "./lighthouse.ts";

/**
 * Every signed-in route in the generated Atlas and Gateway sitemaps, as the nightly Lighthouse run
 * visits them (gate 10, S11.2-06). Each route is visited once, by the first demo person (supabase/
 * seeds, shared demo password) who may open it, with seeded rows in its params. The params follow
 * the axe sweeps (apps/<app>/e2e/a11y/sweep.a11y.ts), plus the rows those leave to the manual audit:
 * the Production team, the Miami workspace, the Gear Requests custom object (seed 1060) and the
 * demo partner agency's console.
 */
export interface RouteSession {
  /** Names the session's report folder. */
  readonly name: string;
  readonly email: string;
  readonly paths: readonly string[];
}

/** A demo person, what the sitemap lets them open, and the seeded rows their routes name. */
interface Person {
  readonly name: string;
  readonly email: string;
  readonly ctx: NavContext;
  readonly params: Readonly<Record<string, string>>;
  /** Limits the person to some routes, such as the partner console's. */
  readonly only?: (route: string) => boolean;
}

const DEMO_ORG = "demo-productions";

const ATLAS_PEOPLE: readonly Person[] = [
  {
    name: "owner",
    email: "owner@example.com",
    ctx: { role: "owner", conditions: ["desktop"] },
    params: {
      org: DEMO_ORG,
      projectKey: "NWS",
      recordKey: "NWS-1",
      // The Admin's Active Projects view, shared with the whole org (seed 0231).
      viewId: "01920000-0000-7000-8000-000002310002",
      teamId: "01920000-0000-7000-8000-000000000501",
      workspaceSlug: "miami",
      objectKey: "gear_requests",
    },
  },
  {
    name: "partner",
    email: "partner@example.com",
    ctx: { role: "owner", conditions: ["desktop", "partner-org"] },
    params: { partnerSlug: "demo-partner" },
    only: (route) => route.startsWith("/partner/"),
  },
];

const GATEWAY_PEOPLE: readonly Person[] = [
  {
    name: "crew",
    email: "crew@example.com",
    ctx: { role: "individual", roleType: "crew", conditions: ["desktop", "paid-work"] },
    params: {
      opportunityKey: toDisplayKey("opportunity", "01920000-0000-7000-8000-000000228101"),
      threadKey: toDisplayKey("thread", "01920000-0000-7000-8000-000000227002"),
      engagementKey: toDisplayKey("engagement", "01920000-0000-7000-8000-000000228401"),
    },
  },
  {
    name: "vendor",
    email: "vendor@example.com",
    // Not company-account: the company settings need the person acting for the account, a choice
    // the session does not carry; they stay with the axe sweep's manual audit.
    ctx: { role: "account-owner", roleType: "vendor", conditions: ["desktop", "paid-work"] },
    params: {
      engagementKey: toDisplayKey("engagement", "01920000-0000-7000-8000-000000228402"),
    },
  },
];

/** Routes Atlas lists but Gateway serves (servedBy), which Atlas only redirects. */
function ownRoutes(sitemap: Sitemap) {
  return flattenRoutes(sitemap).filter((r) => r.auth === "session" && r.servedBy === undefined);
}

function sessionsFor(sitemap: Sitemap, people: readonly Person[]): RouteSession[] {
  const seen = new Set<string>();
  return people.flatMap((person) => {
    const paths = ownRoutes(sitemap)
      .filter(
        (r) =>
          !seen.has(r.id) &&
          (person.only?.(r.route) ?? true) &&
          r.params.every((p) => p in person.params) &&
          isNodeVisible(sitemap, r.id, person.ctx),
      )
      .map((r) => {
        seen.add(r.id);
        return fillRoute(r.route, person.params);
      });
    return paths.length > 0 ? [{ name: person.name, email: person.email, paths }] : [];
  });
}

/** The signed-in routes of an app, grouped by the person who visits them. */
export function signedInRoutes(app: "atlas" | "gateway"): RouteSession[] {
  return app === "atlas"
    ? sessionsFor(atlasSitemap, ATLAS_PEOPLE)
    : sessionsFor(gatewaySitemap, GATEWAY_PEOPLE);
}

/** Signed-in sitemap routes no demo person reaches, with why, for the results file. */
export function unvisitedRoutes(app: "atlas" | "gateway"): string[] {
  const sitemap = app === "atlas" ? atlasSitemap : gatewaySitemap;
  const people = app === "atlas" ? ATLAS_PEOPLE : GATEWAY_PEOPLE;
  const visited = new Set(
    sessionsFor(sitemap, people).flatMap((s) => s.paths.map((p) => `${s.name}:${p}`)),
  );
  return ownRoutes(sitemap)
    .filter((r) =>
      people.every(
        (person) =>
          !r.params.every((p) => p in person.params) ||
          !visited.has(`${person.name}:${fillRoute(r.route, person.params)}`),
      ),
    )
    .map((r) => r.route);
}

/** One Lighthouse CI run: the pages one person (or nobody, for public pages) visits. */
export interface LighthouseRun {
  readonly name: string;
  readonly email: string | null;
  readonly paths: readonly string[];
}

/**
 * The runs for an app. The nightly visits every signed-in route plus the public key pages, the
 * sign-in pages signed out; `keyPagesOnly` keeps to the 16 key pages, as the route JavaScript
 * budget does (bundle-budget.ts), for a quick local check.
 */
export function lighthouseRuns(app: LighthouseApp, keyPagesOnly = false): LighthouseRun[] {
  const target = lighthouseTargets[app];
  if (keyPagesOnly || app === "docs") {
    return [{ name: "key-pages", email: target.email, paths: target.paths }];
  }
  const publicPaths = target.paths.filter((p) => p.startsWith("/auth/"));
  return [{ name: "public", email: null, paths: publicPaths }, ...signedInRoutes(app)];
}
