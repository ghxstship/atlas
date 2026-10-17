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
  await expect(page.getByText("Your inbox is clear.")).toBeVisible();
});
