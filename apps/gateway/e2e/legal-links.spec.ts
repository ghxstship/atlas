import { expect, test } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * The legal links on Gateway's sign-in page (RRR-248). Gateway's root sends a signed-out visitor
 * here, so these are the links its front door shows: each document Gateway publishes among the
 * Privacy Policy, the Consumer Health Data Privacy Policy, the Terms of Service, the Worker Terms,
 * Cookie settings and Contact (lib/legal-links.ts). Every link shown opens a page that answers 200.
 */
test.use({ reducedMotion: "reduce" });

/** Links the footer shows on this build of Gateway, whatever else Gateway has published. */
const ALWAYS_LINKED = [
  { name: "Privacy Policy", href: "/legal/privacy-policy" },
  { name: "Worker Terms", href: "/legal/worker-terms" },
  { name: "Cookie settings", href: "/legal/cookie-settings" },
] as const;

test("a signed-out visitor at Gateway's root reaches the legal links from sign in", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForURL("**/auth/sign-in");
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
  await expectAccessible(page);

  await legal.getByRole("link", { name: "Privacy Policy", exact: true }).click();
  await page.waitForURL("**/legal/privacy-policy");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
});
