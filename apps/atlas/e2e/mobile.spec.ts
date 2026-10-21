import { expect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

test("below md, the bottom bar carries Home, Inbox, Search, My Work and Menu", async ({ page }) => {
  const id = uniqueId();
  const slug = `phone-${id}`;
  await signUp(page, { name: "Pat Phone", email: testEmail("phone", id) });
  await createOrganization(page, { name: `Phone ${id}`, slug });
  const bar = page.getByRole("navigation", { name: "Main" }).last();
  for (const label of ["Home", "Inbox", "Search", "My Work", "Menu"]) {
    await expect(bar.getByText(label, { exact: true })).toBeVisible();
  }
  await expectAccessible(page);
  await bar.getByText("Inbox", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${slug}/inbox$`));
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible();

  // A59-001: Menu opens the navigation drawer, and choosing a page there closes it.
  await bar.getByText("Menu", { exact: true }).click();
  const opener = page.getByRole("button", { name: "Open navigation", expanded: true });
  await expect(opener).toBeVisible();
  const drawer = page.locator(`[id="${await opener.getAttribute("aria-controls")}"]`);
  await expect(drawer).toBeVisible();
  await expectAccessible(page);
  await drawer.getByRole("link", { name: "Home", exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/${slug}/home$`));
  await expect(drawer).toBeHidden();
});
