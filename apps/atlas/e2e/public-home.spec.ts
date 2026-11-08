import type { Page } from "@playwright/test";
import { expect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * The public homepage (RRR-248). A signed-out visitor at the root reads what XOS is, finds the way
 * to sign in, and reaches the Privacy Policy and the Consumer Health Data Privacy Policy from the
 * footer, as Washington's and Nevada's health data laws and Google's OAuth review ask. The sign-in
 * page carries the same links. A signed-in person still lands on their org's start page.
 */
test.use({ reducedMotion: "reduce" });

const LEGAL_LINKS = [
  { name: "Privacy Policy", href: "/legal/privacy-policy" },
  {
    name: "Consumer Health Data Privacy Policy",
    href: "/legal/consumer-health-data-privacy-policy",
  },
  { name: "Terms of Service", href: "/legal/terms-of-service" },
  { name: "Cookie settings", href: "/legal/cookie-settings" },
  { name: "Contact", href: "/legal/contact" },
] as const;

async function expectLegalLinks(page: Page): Promise<void> {
  const legal = page.getByRole("navigation", { name: "Legal" });
  for (const link of LEGAL_LINKS) {
    await expect(legal.getByRole("link", { name: link.name, exact: true })).toHaveAttribute(
      "href",
      link.href,
    );
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
