import { describe, expect, it } from "vitest";
import { ATLAS_ROLES, flattenRoutes, isNodeVisible, type NavContext } from "@xos/ia";
import { decideRoute } from "../lib/shell/guard";
import { sitemap } from "../ia/sitemap.generated";

const navAs =
  (role: string | null, extra: Partial<NavContext> = {}) =>
  async (slug: string): Promise<NavContext | null> =>
    slug === "acme" && role !== null ? { role, conditions: ["desktop"], ...extra } : null;

const decide = (path: string, role: string | null, signedIn = true, extra = {}) =>
  decideRoute(sitemap, { path, search: "", signedIn, navFor: navAs(role, extra) });

describe("proxy route guard", () => {
  it("passes shell routes and sends the org root to Home", async () => {
    expect(await decide("/", null, false)).toEqual({ kind: "pass" });
    expect(await decide("/auth/sign-in", null, false)).toEqual({ kind: "pass" });
    expect(await decide("/acme", "owner")).toEqual({ kind: "redirect", to: "/acme/home" });
    expect(await decide("/acme", null, false)).toEqual({
      kind: "redirect",
      to: "/auth/sign-in?next=%2Facme%2Fhome",
    });
  });

  it("sends signed-out visitors to sign in, keeping where they were going", async () => {
    expect(
      await decideRoute(sitemap, {
        path: "/acme/inbox",
        search: "?view=list",
        signedIn: false,
        navFor: navAs(null),
      }),
    ).toEqual({ kind: "redirect", to: "/auth/sign-in?next=%2Facme%2Finbox%3Fview%3Dlist" });
  });

  it("passes public routes and unknown paths through to the app", async () => {
    expect(await decide("/legal/terms-of-service", null, false)).toEqual({ kind: "pass" });
    expect(await decide("/acme/not-a-page/at-all/really", "owner")).toEqual({ kind: "pass" });
  });

  it("answers 404 for an org the viewer does not belong to", async () => {
    expect(await decide("/other/home", "owner")).toEqual({ kind: "not-found" });
  });

  it("answers 404, never 403, for routes hidden from a role (Section 4.5.9)", async () => {
    expect(await decide("/acme/finance/budgets", "owner")).toEqual({ kind: "pass" });
    expect(await decide("/acme/finance/budgets", "viewer")).toEqual({ kind: "not-found" });
    expect(await decide("/acme/finance/budgets", "field")).toEqual({ kind: "not-found" });
    expect(await decide("/acme/settings/general", "admin")).toEqual({ kind: "pass" });
    expect(await decide("/acme/settings/billing-and-plan", "admin")).toEqual({
      kind: "not-found",
    });
    expect(await decide("/acme/settings/billing-and-plan", "owner")).toEqual({ kind: "pass" });
    expect(await decide("/acme/settings", "manager")).toEqual({ kind: "not-found" });
    expect(await decide("/acme/activity/audit-log", "manager")).toEqual({ kind: "not-found" });
    expect(await decide("/acme/home", "viewer")).toEqual({ kind: "pass" });
  });

  it("hides modules an org turned off", async () => {
    expect(
      await decide("/acme/finance/budgets", "owner", true, { disabledModules: ["finance"] }),
    ).toEqual({ kind: "not-found" });
  });

  it("applies conditions: partner settings need a partner org", async () => {
    expect(await decide("/acme/settings/partner", "owner")).toEqual({ kind: "not-found" });
    expect(
      await decide("/acme/settings/partner", "owner", true, {
        conditions: ["desktop", "partner-org"],
      }),
    ).toEqual({ kind: "pass" });
  });

  it("agrees with sitemap visibility for every org route and every role", async () => {
    const routes = flattenRoutes(sitemap).filter(
      (r) => r.route.startsWith("/{org}/") && r.params.length === 1,
    );
    for (const role of ATLAS_ROLES) {
      for (const r of routes) {
        const path = r.route.replace("{org}", "acme");
        const expected = isNodeVisible(sitemap, r.id, { role, conditions: ["desktop"] })
          ? "pass"
          : "not-found";
        expect((await decide(path, role)).kind, `${role} ${path}`).toBe(expected);
      }
    }
  });
});
