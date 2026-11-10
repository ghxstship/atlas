import { expect, test } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * The legal documents Gateway serves (Section 14.4): the full text, server-rendered, under a notice
 * while the version is a draft. The text is read with JavaScript off, because the page must not
 * need it. Terms of Service used to answer 404 here, as it was not on Gateway's list.
 */

const DOCUMENTS = [
  { slug: "privacy-policy", title: "Privacy Policy", section: "2. Contact Points" },
  { slug: "terms-of-service", title: "Terms of Service", section: "1. Definitions" },
];

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  for (const { slug, title, section } of DOCUMENTS) {
    test(`/legal/${slug} shows its full text under the draft notice`, async ({ page }) => {
      const response = await page.goto(`/legal/${slug}`);
      expect(response?.status()).toBe(200);
      const h1 = page.getByRole("heading", { level: 1, name: title });
      await expect(h1).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: section })).toBeVisible();
      // In effect since 2026-11-10 (ADR 0168 sign-off): no draft notice, and the page states the version and its date.
      await expect(page.getByText("Draft before launch.")).toHaveCount(0);
      await expect(page.getByText("Draft, not yet in effect", { exact: true })).toHaveCount(0);
      await expect(page.getByText(/^Version 1\.0\.0, in effect from /).first()).toBeVisible();
      // Terms of Service 15: every version, its effective date and a summary of changes.
      const history = page.getByRole("region", { name: "Version history" });
      await expect(history.getByRole("listitem")).toHaveCount(1);
      await expect(history.getByText(/^Version 1\.0\.0: in effect from /)).toBeVisible();
      await expect(history.getByText("First version.")).toHaveAttribute("lang", "en-US");
    });
  }

  test("the outline opens with no script and reaches a section", async ({ page }) => {
    await page.goto("/legal/terms-of-service");
    const outline = page.getByRole("navigation", { name: "On this page" });
    await outline.getByText("On this page").click();
    await outline.getByRole("link", { name: "1. Definitions" }).click();
    await expect(page).toHaveURL(/#section-1$/);
    await expect(page.locator("#section-1")).toBeInViewport();
  });

  test("a document Gateway serves opens here, and any other opens on Atlas", async ({ page }) => {
    // Gateway serves the Legal Contact page (lib/auth/legal.ts), so its path stays here.
    await page.goto("/legal/terms-of-service");
    await expect(page.getByRole("link", { name: "/legal/contact" }).first()).toHaveAttribute(
      "href",
      "/legal/contact",
    );
    await page.goto("/legal/privacy-policy");
    await expect(
      page.getByRole("link", { name: "/legal/text-message-terms" }).first(),
    ).toHaveAttribute("href", "https://atlas.ghxstship.tech/legal/text-message-terms");
    await page.goto("/legal/cookie-policy");
    await expect(
      page.getByRole("link", { name: "/legal/cookie-settings" }).first(),
    ).toHaveAttribute("href", "/legal/cookie-settings");
  });

  test("Gateway still answers 404 for a document it does not serve", async ({ page }) => {
    const response = await page.goto("/legal/data-processing-agreement");
    expect(response?.status()).toBe(404);
  });
});

for (const { slug } of DOCUMENTS) {
  test(`/legal/${slug} passes the accessibility check and keeps to the width of a phone`, async ({
    page,
  }) => {
    await page.goto(`/legal/${slug}`);
    await expectAccessible(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page);
  });
}

test("Spanish labels the page in Spanish and says the text is in English", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: "xos-locale", value: "es-US", url: baseURL ?? "" }]);
  await page.goto("/legal/worker-terms");
  await expect(page.locator("html")).toHaveAttribute("lang", "es-US");
  await expect(page.getByText(/^Versión 1\.0\.0, vigente desde el /).first()).toBeVisible();
  await expect(page.getByText("Este documento se publica solo en inglés.")).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Historial de versiones" })
      .getByText(/^Versión 1\.0\.0: vigente desde el /),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Worker Terms" })).toBeVisible();
});
