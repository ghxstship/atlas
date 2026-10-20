import { expect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

test("the shell navigates from the sitemap: sidebar, command menu, breadcrumbs, focus mode", async ({
  page,
}) => {
  const id = uniqueId();
  const slug = `shell-${id}`;
  await signUp(page, { name: "Sam Shell", email: testEmail("shell", id) });
  await createOrganization(page, { name: `Shell ${id}`, slug });
  await page.screenshot({ path: "node_modules/.cache/playwright/shell-home.png", fullPage: true });

  const main = page.getByRole("navigation", { name: "Quick Access" });
  await expect(main.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await expect(main.getByRole("link", { name: "Inbox" })).toBeVisible();
  await expect(main.getByRole("link", { name: "My Work" })).toBeVisible();
  await expect(page.getByText("Pin projects, saved views and records")).toBeVisible();

  // Module groups start collapsed for an Owner; opening one reveals its items.
  await page.getByRole("button", { name: "Commercial" }).click();
  await page.getByRole("link", { name: "Finance" }).click();
  await expect(page).toHaveURL(new RegExp(`/${slug}/finance$`));
  await expect(page.getByRole("heading", { level: 1, name: "Finance" })).toBeVisible();
  await expectAccessible(page);

  // Command menu: Cmd or Ctrl+K, search, Enter.
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  await page.keyboard.press("ControlOrMeta+k");
  // The menu loads on first use; typing before it opens would be lost.
  await expect(page.getByRole("dialog").filter({ has: page.getByRole("combobox") })).toBeVisible();
  await page.keyboard.type("Purchase Orders");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/${slug}/procurement/purchase-orders$`));
  await expect(page.getByText("No purchase orders yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "New purchase order" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Procurement");
  await expectAccessible(page);

  // Focus mode hides the sidebar and comes back.
  await page.keyboard.press("ControlOrMeta+.");
  await expect(main).toBeHidden();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(main).toBeVisible();

  // An unknown page is 404 with the System template.
  const response = await page.goto(`/${slug}/finance/not-a-page`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
