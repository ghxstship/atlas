import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./support";
import { DEMO_ORG, PARTNER_ORG, signInAs } from "./a36-support";

/**
 * A36's pages at phone width (Section 11.10, ADR 0013): every page fits 375 px with no horizontal page
 * scroll and stays axe clean.
 */
test.use({ viewport: { width: 375, height: 812 } });

async function fits(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status(), path).toBe(200);
  await page.waitForLoadState("networkidle");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${path} scrolls sideways by ${overflow} px`).toBeLessThanOrEqual(1);
  await expectAccessible(page);
}

test("A36 pages fit 375 px for the demo Owner and Admin", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAs(page, "owner@example.com", DEMO_ORG);
  for (const path of [
    `/${DEMO_ORG}/inbox`,
    `/${DEMO_ORG}/import`,
    `/${DEMO_ORG}/objects/gear_requests`,
    `/${DEMO_ORG}/objects/gear_requests?view=table`,
    `/${DEMO_ORG}/settings/custom-objects`,
    `/${DEMO_ORG}/settings/danger-zone`,
    `/${DEMO_ORG}/settings/roles-and-capabilities`,
  ]) {
    await fits(page, path);
  }
});

test("the partner console fits 375 px", async ({ page }) => {
  await signInAs(page, "partner@example.com", PARTNER_ORG);
  for (const section of ["", "/client-orgs", "/default-brand", "/usage", "/wholesale-billing"]) {
    await fits(page, `/partner/${PARTNER_ORG}${section}`);
  }
});
