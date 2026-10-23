import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Every page template of the docs site, in both locales and both themes, with reduced motion:
 * axe finds no serious or critical violation (Section 18, gate 8), and the keyboard reaches
 * the content through the skip link.
 */
test.use({ reducedMotion: "reduce" });

async function expectAccessible(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
}

const PAGES = [
  { path: "/en-US", heading: "Build on XOS" },
  { path: "/en-US/guides/getting-started", heading: "Quickstart" },
  { path: "/en-US/guides/self-hosting", heading: "Self-hosting" },
  { path: "/en-US/reference", heading: "API reference" },
  { path: "/en-US/reference/projects", heading: "projects" },
  { path: "/en-US/reference/projects/list", heading: "List project rows" },
  { path: "/en-US/data-dictionary/app.time_entries", heading: "app.time_entries" },
  { path: "/es-US/data-dictionary/xpms.dim_department", heading: "xpms.dim_department" },
  { path: "/en-US/help", heading: "Help center" },
  { path: "/en-US/help/gates", heading: "Gates" },
  { path: "/en-US/help?q=gate", heading: "Help center" },
  { path: "/en-US/help?q=zzzz", heading: "Help center" },
  { path: "/en-US/help/gateway/engagement-invoices", heading: "Invoices" },
  { path: "/es-US/help/compass/today", heading: "Hoy" },
  { path: "/es-US", heading: "Desarrolla sobre XOS" },
  { path: "/es-US/guides/errors", heading: "Errores y rechazos" },
  { path: "/es-US/reference/purchase-orders", heading: "purchaseOrders" },
  { path: "/es-US/reference/purchase-orders/create", heading: "Create a purchase order" },
  { path: "/en-US/does-not-exist", heading: "This page does not exist" },
];

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });
    for (const { path, heading } of PAGES) {
      test(`${path} renders and is accessible`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expectAccessible(page);
      });
    }
  });
}

test("a path without a locale redirects to the visitor's language", async ({ page, browser }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/en-US$/);
  const spanish = await browser.newContext({ locale: "es-MX", reducedMotion: "reduce" });
  const es = await spanish.newPage();
  await es.goto("/guides/cli");
  await expect(es).toHaveURL(/\/es-US\/guides\/cli$/);
  await spanish.close();
});

test("the skip link moves focus to the content", async ({ page }) => {
  await page.goto("/en-US/guides/writes");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#content$/);
});

test("the theme switch persists the choice", async ({ page }) => {
  await page.goto("/en-US");
  await page.getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("help search finds articles and names the next action when nothing matches", async ({
  page,
}) => {
  await page.goto("/en-US/help");
  await page.getByRole("searchbox", { name: "Search help" }).fill("gate");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("heading", { name: /articles match gate/ })).toBeVisible();
  await page.goto("/en-US/help?q=zzzz");
  await expect(page.getByText(/Try a shorter word/)).toBeVisible();
});

test("the OpenAPI document downloads", async ({ request }) => {
  const response = await request.get("/openapi.json");
  expect(response.ok()).toBe(true);
  expect(((await response.json()) as { openapi: string }).openapi).toBe("3.1.0");
});
