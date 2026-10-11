import { expect, test } from "@playwright/test";
import { fillRoute, flattenRoutes, isNodeVisible } from "@xos/ia";
import { sitemap } from "../ia/sitemap.generated";
import { DATA_PARAMS, DELEGATED } from "../ia/routes.config";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * Gate 15 in the browser: every Atlas sitemap route an Owner may open renders with status 200 and
 * passes axe; routes that name a data row (project, record, saved view, custom object) answer 404
 * while no such row exists; partner routes answer 404 for an org that is not a partner.
 */
test("every sitemap route renders for an Owner, with axe clean", async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const id = uniqueId();
  const slug = `crawl-${id}`;
  await signUp(page, { name: "Cleo Crawl", email: testEmail("crawl", id) });
  await createOrganization(page, { name: `Crawl ${id}`, slug });

  const nav = { role: "owner", conditions: ["desktop" as const] };
  const routes = flattenRoutes(sitemap).filter(
    (r) => r.auth === "session" && r.servedBy === undefined && !(r.id in DELEGATED),
  );
  const failures: string[] = [];
  for (const route of routes) {
    const dataRow = route.params.some((p) => (DATA_PARAMS as readonly string[]).includes(p));
    const params: Record<string, string> = {
      org: slug,
      partnerSlug: slug,
      projectKey: "NWL",
      recordKey: "NWL-1",
      viewId: "00000000-0000-4000-8000-000000000000",
      objectKey: "rigging",
    };
    const path = fillRoute(route.route, params);
    const expected = !dataRow && isNodeVisible(sitemap, route.id, nav) ? 200 : 404;
    const response = await page.goto(path);
    if (response?.status() !== expected) {
      failures.push(`${path}: ${response?.status()} (expected ${expected})`);
      continue;
    }
    if (expected === 200) {
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expectAccessible(page);
    }
  }
  expect(failures).toEqual([]);
});
