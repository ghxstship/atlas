import { ORG, signIn } from "./a16-support";
import { expect, test } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * Tablet (Section 4.10, Safari on iPadOS): run by the ipados-safari project, an iPad between md
 * and lg. The sidebar folds into a drawer the top bar's menu button opens, the phone bottom bar
 * stays away, nothing scrolls sideways, and choosing a page closes the drawer (A59-001).
 */
test("on a tablet the sidebar opens from the top bar and closes on navigation", async ({
  page,
}) => {
  await signIn(page);
  const opener = page.getByRole("button", { name: "Open navigation" });
  await expect(opener).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).last()).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectAccessible(page);

  await opener.tap();
  const drawer = page.locator(`[id="${await opener.getAttribute("aria-controls")}"]`);
  await expect(drawer).toBeVisible();
  await drawer.getByRole("link", { name: "Projects", exact: true }).first().tap();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/projects$`));
  await expect(drawer).toBeHidden();
});
