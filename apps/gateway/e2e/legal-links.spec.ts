import { expect, test } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * The legal links on Gateway's sign-in page (RRR-248): the Privacy Policy, the Consumer Health Data
 * Privacy Policy, the Terms of Service, Cookie settings and Contact, as on the Atlas homepage.
 * Gateway's root sends a signed-out visitor here, so these are the links its front door shows.
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

test("a signed-out visitor at Gateway's root reaches the legal links from sign in", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForURL("**/auth/sign-in");
  const legal = page.getByRole("navigation", { name: "Legal" });
  for (const link of LEGAL_LINKS) {
    await expect(legal.getByRole("link", { name: link.name, exact: true })).toHaveAttribute(
      "href",
      link.href,
    );
  }
  await expectAccessible(page);

  await legal.getByRole("link", { name: "Privacy Policy", exact: true }).click();
  await page.waitForURL("**/legal/privacy-policy");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
});
