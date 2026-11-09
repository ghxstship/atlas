import type { Page } from "@playwright/test";
import { expect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * The public homepage (RRR-248). A signed-out visitor at the root reads what XOS is, finds the way
 * to sign in, and reaches the legal documents from the footer: the Privacy Policy Google's OAuth
 * review asks for, and the Consumer Health Data Privacy Policy Washington's and Nevada's health data
 * laws ask for once the registry publishes it (lib/legal-links.ts). Every link the footer shows opens
 * a page that answers 200. The sign-in page carries the same links. A signed-in person still lands on
 * their org's start page.
 */
test.use({ reducedMotion: "reduce" });

/** Links the footer shows on this build of Atlas, whatever else the registry has published. */
const ALWAYS_LINKED = [
  { name: "Privacy Policy", href: "/legal/privacy-policy" },
  { name: "Terms of Service", href: "/legal/terms-of-service" },
  { name: "Worker Terms", href: "/legal/worker-terms" },
  { name: "Cookie settings", href: "/legal/cookie-settings" },
  { name: "Contact", href: "/legal/contact" },
] as const;

/** Every legal link the page shows names a /legal page, the expected ones among them, and each answers 200. */
async function expectLegalLinks(page: Page): Promise<void> {
  const legal = page.getByRole("navigation", { name: "Legal" });
  for (const link of ALWAYS_LINKED) {
    await expect(legal.getByRole("link", { name: link.name, exact: true })).toHaveAttribute(
      "href",
      link.href,
    );
  }
  const hrefs = await legal
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
  expect(hrefs.length).toBeGreaterThanOrEqual(ALWAYS_LINKED.length);
  for (const href of hrefs) {
    expect(href).toMatch(/^\/legal\/[a-z-]+$/);
    const response = await page.request.get(href);
    expect(response.status(), href).toBe(200);
  }
}

test("a signed-out visitor at the root reads what XOS is and finds the legal links", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Run every live production in one place" }),
  ).toBeVisible();
  await expect(
    page.getByText(/XOS is production software from GHXSTSHIP Industries LLC/),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Signing in with Google" }),
  ).toBeVisible();
  await expectLegalLinks(page);
  await expectAccessible(page);

  await page
    .getByRole("navigation", { name: "Legal" })
    .getByRole("link", { name: "Privacy Policy", exact: true })
    .click();
  await page.waitForURL("**/legal/privacy-policy");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();

  await page.goto("/");
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/auth/sign-in");
  await expectLegalLinks(page);
  await expectAccessible(page);
});

test("a signed-in person at the root still lands on their org's start page", async ({ page }) => {
  const id = uniqueId();
  const slug = `home-${id}`;
  await signUp(page, { name: "Hana Home", email: testEmail("home", id) });
  await createOrganization(page, { name: `Home ${id}`, slug });
  await page.goto("/");
  await page.waitForURL(`**/${slug}/home`);
  await expect(page.getByRole("navigation", { name: "Legal" })).toHaveCount(0);
});
