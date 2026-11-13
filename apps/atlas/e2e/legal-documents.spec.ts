import { expect, test } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * The published legal documents on Atlas (Section 14.4): the full text, server-rendered, under a
 * notice while the version is a draft. The text is read with JavaScript off, because the page must
 * not need it.
 */

const DOCUMENTS = [
  // Privacy Policy 1.1.0 (2026-11-11): Sent, Inc. delivers text messages in place of Twilio.
  {
    slug: "privacy-policy",
    title: "Privacy Policy",
    section: "2. Contact Points",
    version: "1.1.0",
    versions: 2,
  },
  {
    slug: "terms-of-service",
    title: "Terms of Service",
    section: "1. Definitions",
    version: "1.0.0",
    versions: 1,
  },
];

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  for (const { slug, title, section, version, versions } of DOCUMENTS) {
    test(`/legal/${slug} shows its full text under the draft notice`, async ({ page }) => {
      const response = await page.goto(`/legal/${slug}`);
      expect(response?.status()).toBe(200);
      const h1 = page.getByRole("heading", { level: 1, name: title });
      await expect(h1).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: section })).toBeVisible();
      // In effect since 2026-11-10 (ADR 0168 sign-off): no draft notice, and the page states the version and its date.
      await expect(page.getByText("Draft before launch.")).toHaveCount(0);
      await expect(page.getByText("Draft, not yet in effect", { exact: true })).toHaveCount(0);
      await expect(
        page.getByText(`Version ${version}, in effect from `, { exact: false }).first(),
      ).toBeVisible();
      // Terms of Service 15: every version, its effective date and a summary of changes.
      const history = page.getByRole("region", { name: "Version history" });
      await expect(history.getByRole("listitem")).toHaveCount(versions);
      await expect(history.getByText(/^Version 1\.0\.0: in effect from /)).toBeVisible();
      await expect(
        history.getByText(`Version ${version}: in effect from `, { exact: false }),
      ).toBeVisible();
      await expect(history.getByText("First version.")).toHaveAttribute("lang", "en-US");
      await expect(h1.locator("xpath=ancestor::*[@lang='en-US'][1]")).toHaveCount(1);
    });
  }

  test("links between sections and documents work", async ({ page }) => {
    await page.goto("/legal/terms-of-service");
    const contact = page.getByRole("link", { name: "/legal/contact" }).first();
    await expect(contact).toHaveAttribute("href", "/legal/contact");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page
      .getByRole("navigation", { name: "On this page" })
      .getByRole("link", { name: "1. Definitions" })
      .first()
      .click();
    await expect(page).toHaveURL(/#section-1$/);
    await expect(page.locator("#section-1")).toBeInViewport();
    await contact.click();
    await expect(page).toHaveURL(/\/legal\/contact$/);
    await expect(page.getByRole("heading", { level: 1, name: "Legal Contact" })).toBeVisible();
    await expect(
      // One address since 2026-11-08: the Email section names it before its table of subject lines.
      page.locator("article").getByRole("link", { name: "support@ghxstship.pro" }).first(),
    ).toHaveAttribute("href", "mailto:support@ghxstship.pro");
  });

  test("an internal document is never served", async ({ page }) => {
    const response = await page.goto("/legal/soc2-controls");
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

test("a keyboard reaches and scrolls a wide table", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/legal/subprocessors");
  const region = page.getByRole("region", { name: "2. Infrastructure Subprocessors" });
  await region.focus();
  await expect(region).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
});

test("the Subprocessor List keeps its change notices", async ({ page }) => {
  await page.goto("/legal/subprocessors");
  await expect(page.getByRole("heading", { level: 1, name: "Subprocessor List" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Change notices" })).toBeVisible();
});

test("Spanish labels the page in Spanish and says the text is in English", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: "xos-locale", value: "es-US", url: baseURL ?? "" }]);
  await page.goto("/legal/privacy-policy");
  await expect(page.locator("html")).toHaveAttribute("lang", "es-US");
  await expect(page.getByText(/^Versión 1\.1\.0, vigente desde el /).first()).toBeVisible();
  await expect(page.getByText("Este documento se publica solo en inglés.")).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Historial de versiones" })
      .getByText(/^Versión 1\.0\.0: vigente desde el /),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
});
