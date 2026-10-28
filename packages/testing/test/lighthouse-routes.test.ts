import { flattenRoutes } from "@xos/ia";
import { describe, expect, it } from "vitest";
import { sitemap as atlasSitemap } from "../../../apps/atlas/ia/sitemap.generated.ts";
import { sitemap as gatewaySitemap } from "../../../apps/gateway/ia/sitemap.generated.ts";
import { lighthouseTargets } from "../src/lighthouse.ts";
import { lighthouseRuns, signedInRoutes, unvisitedRoutes } from "../src/lighthouse-routes.ts";

const SITEMAPS = { atlas: atlasSitemap, gateway: gatewaySitemap } as const;

/** A route pattern as a regular expression, each `{param}` one path segment of any form. */
const pattern = (route: string) =>
  new RegExp(`^${route.replace(/\{[^}]+\}/g, "[^/]+").replace(/\./g, "\\.")}$`);

describe("signedInRoutes", () => {
  for (const app of ["atlas", "gateway"] as const) {
    const sitemap = SITEMAPS[app];
    const sessionRoutes = flattenRoutes(sitemap).filter(
      (r) => r.auth === "session" && r.servedBy === undefined,
    );
    const sessions = signedInRoutes(app);
    const paths = sessions.flatMap((s) => s.paths);

    it(`${app}: visits each route once, with every param filled from the seed`, () => {
      expect(new Set(paths).size).toBe(paths.length);
      for (const path of paths) expect(path).not.toMatch(/[{}]/);
    });

    it(`${app}: every visited path is a signed-in sitemap route`, () => {
      for (const path of paths) {
        const match = sessionRoutes.some((r) => pattern(r.route).test(path));
        expect(match, path).toBe(true);
      }
    });

    it(`${app}: leaves out only the routes no seeded person can open`, () => {
      const unvisited = unvisitedRoutes(app);
      expect(paths.length + unvisited.length).toBe(sessionRoutes.length);
    });
  }

  it("covers Atlas as the Owner and the partner console as the partner's Owner", () => {
    const [owner, partner] = signedInRoutes("atlas");
    expect(owner?.email).toBe("owner@example.com");
    expect(owner?.paths).toContain("/demo-productions/projects");
    expect(owner?.paths).toContain("/demo-productions/settings/workspaces/miami");
    expect(partner?.paths.every((p) => p.startsWith("/partner/demo-partner"))).toBe(true);
    expect(unvisitedRoutes("atlas").length).toBeLessThanOrEqual(2);
  });

  it("covers Gateway as the crew member, then the vendor's company pages", () => {
    const [crew, vendor] = signedInRoutes("gateway");
    expect(crew?.email).toBe("crew@example.com");
    expect(crew?.paths).toContain("/home");
    expect(vendor?.paths.some((p) => p.startsWith("/settings/company"))).toBe(true);
  });
});

describe("lighthouseRuns", () => {
  it("visits the sign-in page signed out and every signed-in route signed in", () => {
    const runs = lighthouseRuns("atlas");
    expect(runs[0]).toEqual({ name: "public", email: null, paths: ["/auth/sign-in"] });
    expect(runs.slice(1).map((r) => r.name)).toEqual(["owner", "partner"]);
    expect(runs.reduce((n, r) => n + r.paths.length, 0)).toBeGreaterThan(200);
  });

  it("keeps to the key pages on request, and docs to its public pages", () => {
    expect(lighthouseRuns("gateway", true)).toEqual([
      { name: "key-pages", email: "crew@example.com", paths: lighthouseTargets.gateway.paths },
    ]);
    expect(lighthouseRuns("docs")).toEqual([
      { name: "key-pages", email: null, paths: lighthouseTargets.docs.paths },
    ]);
  });
});
