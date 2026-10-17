import { expect, type Page, test } from "./engine-test";
import { publishCrewOpportunity } from "./fixtures";
import { expectAccessible, signIn } from "./support";

/**
 * Phone first (Section 4.5.8; Section 11.12 Apply): on a phone the five destinations sit in a
 * bottom bar, nothing scrolls sideways, and an opportunity found in Explore is applied to in three
 * taps when it asks no questions.
 */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("the bottom bar carries the five destinations", async ({ page }) => {
  await signIn(page, "crew@example.com");
  const bar = page.getByRole("navigation", { name: "Primary navigation" }).last();
  await expect(bar).toBeVisible();
  const box = await bar.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport ? box.y + box.height : 0).toBeGreaterThan((viewport?.height ?? 0) - 4);
  for (const name of ["Home", "Explore", "Work", "Money", "Messages"]) {
    await expect(bar.getByRole("link", { name })).toBeVisible();
  }
  await expectNoSidewaysScroll(page);
  await expectAccessible(page);

  await bar.getByRole("link", { name: "Work" }).tap();
  await expect(page).toHaveURL(/\/work\/upcoming$/);
  await expectNoSidewaysScroll(page);
});

test("apply in three taps from Explore", async ({ page }) => {
  const opportunity = await publishCrewOpportunity(false);
  await signIn(page, "crew@example.com", `/explore?q=${encodeURIComponent(opportunity.title)}`);
  await expectNoSidewaysScroll(page);

  await page.getByRole("link", { name: opportunity.title }).first().tap(); // 1
  const form = page.getByRole("form", { name: /^Apply for / });
  await form.getByLabel("I am available for these dates").tap(); // 2
  await form.getByRole("button", { name: "Send application" }).tap(); // 3
  await expect(page.getByText("Application sent. Follow it under Applications.")).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectAccessible(page);
});
