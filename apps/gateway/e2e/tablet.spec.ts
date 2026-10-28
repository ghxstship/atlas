import { expect, test } from "./engine-test";
import { expectAccessible, signIn } from "./support";

/**
 * Tablet (Section 4.10, Safari on iPadOS): run by the ipados-safari project, an iPad at md and
 * above. The five destinations sit in the top bar rather than the phone's bottom bar, and nothing
 * scrolls sideways.
 */
test("on a tablet the five destinations sit in the top bar", async ({ page }) => {
  await signIn(page, "crew@example.com");
  const [top, bottom] = [
    page.getByRole("navigation", { name: "Primary navigation" }).first(),
    page.getByRole("navigation", { name: "Primary navigation" }).last(),
  ];
  for (const name of ["Home", "Explore", "Work", "Money", "Messages"]) {
    await expect(top.getByRole("link", { name })).toBeVisible();
  }
  await expect(bottom).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectAccessible(page);

  await top.getByRole("link", { name: "Work" }).tap();
  await expect(page).toHaveURL(/\/work\/upcoming$/);
});
