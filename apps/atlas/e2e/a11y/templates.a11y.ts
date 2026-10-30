import { expect, test } from "@playwright/test";
import { fillRoute, flattenRoutes, isNodeVisible } from "@xos/ia";
import { DELEGATED } from "../../ia/routes.config";
import { sitemap } from "../../ia/sitemap.generated";
import { activeRoles, DEMO_ORG, storageStatePath } from "./roles";

/**
 * Section 20.1, criterion 10 (A129): every page in Atlas uses one of the Section 11.6 templates. Each
 * Template* root marks itself with data-template, so on every route the accessibility sweep visits
 * for each demo role (sweep.a11y.ts, the same routes and seeded params), the page's main region holds
 * exactly one outermost template root. A template inside another (a Collection inside the Settings
 * template's form column) belongs to it and is not counted. The template does not change with the
 * viewport, so this runs in the desktop project only.
 */
const PARAMS: Readonly<Record<string, string>> = {
  org: DEMO_ORG,
  projectKey: "NWS",
  recordKey: "NWS-1",
  viewId: "01920000-0000-7000-8000-000002310003",
};

const routes = flattenRoutes(sitemap).filter(
  (r) =>
    r.auth === "session" &&
    r.servedBy === undefined &&
    !(r.id in DELEGATED) &&
    r.params.every((p) => p in PARAMS),
);

for (const { role } of activeRoles()) {
  test.describe(`${role} templates`, () => {
    test.use({ storageState: storageStatePath(role) });
    const ctx = { role, conditions: ["desktop" as const] };
    const visible = routes.filter((r) => isNodeVisible(sitemap, r.id, ctx));
    for (const route of visible) {
      const path = fillRoute(route.route, PARAMS);
      test(`${route.id} ${path}`, async ({ page }, info) => {
        test.skip(info.project.name !== "desktop-1280", "the template is the same at every width");
        const response = await page.goto(path);
        if (response?.status() === 404 && route.params.some((p) => p !== "org")) {
          // The role cannot see the seeded row: data access, as in the sweep, so no page to check.
          test.skip();
        }
        const main = page.locator("main").first();
        await main
          .locator("[data-template]")
          .first()
          .waitFor({ state: "attached", timeout: 15_000 })
          .catch(() => undefined);
        const roots = await main.evaluate((el) =>
          [...el.querySelectorAll("[data-template]")]
            .filter((t) => !t.parentElement?.closest("[data-template]"))
            .map((t) => t.getAttribute("data-template")),
        );
        expect(roots, `${path} renders ${roots.length} template roots`).toHaveLength(1);
      });
    }
  });
}
