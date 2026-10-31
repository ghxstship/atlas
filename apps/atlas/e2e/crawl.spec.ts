import type { Page } from "@playwright/test";
import { expect, test } from "./engine-test";
import { fillRoute, flattenRoutes, isNodeVisible } from "@xos/ia";
import { sitemap } from "../ia/sitemap.generated";
import { DATA_PARAMS, DELEGATED } from "../ia/routes.config";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * Gate 15 in the browser: every Atlas sitemap route an Owner may open renders with status 200 and
 * passes axe; routes that name a data row (project, record, saved view, custom object) answer 404
 * while no such row exists; partner routes answer 404 for an org that is not a partner.
 *
 * The routes are crawled in parts of CRAWL_PART_SIZE, each with its own Owner and org, so the crawl
 * keeps one test timeout per part however many routes the sitemap grows to (one test over all 260
 * routes passed 15 minutes on CI), and a retry repeats one part instead of the whole crawl.
 */
const CRAWL_PART_SIZE = 50;
const nav = { role: "owner", conditions: ["desktop" as const] };
const routes = flattenRoutes(sitemap).filter(
  (r) => r.auth === "session" && r.servedBy === undefined && !(r.id in DELEGATED),
);
const parts = Math.ceil(routes.length / CRAWL_PART_SIZE);

for (let part = 0; part < parts; part++) {
  const slice = routes.slice(part * CRAWL_PART_SIZE, (part + 1) * CRAWL_PART_SIZE);
  test(`every sitemap route renders for an Owner, with axe clean (part ${part + 1} of ${parts})`, async ({
    page,
  }) => {
    test.setTimeout(15 * 60_000);
    const id = uniqueId();
    const slug = `crawl-${id}`;
    await signUp(page, { name: "Cleo Crawl", email: testEmail("crawl", id) });
    await createOrganization(page, { name: `Crawl ${id}`, slug });
    await crawl(page, slug, slice);
  });
}

async function crawl(page: Page, slug: string, slice: typeof routes) {
  const failures: string[] = [];
  for (const route of slice) {
    const dataRow = route.params.some((p) => (DATA_PARAMS as readonly string[]).includes(p));
    const params: Record<string, string> = {
      org: slug,
      partnerSlug: slug,
      projectKey: "NWL",
      recordKey: "NWL-1",
      viewId: "00000000-0000-4000-8000-000000000000",
      objectKey: "rigging",
      // A workspace and a team that do not exist: their settings pages answer 404 (A86).
      workspaceSlug: "no-such-workspace",
      teamId: "00000000-0000-4000-8000-000000000001",
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
}
