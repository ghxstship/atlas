import { expect, test } from "./engine-test";
import { ORG, settled, signIn } from "./operations-support";

/**
 * The shell's global `?peek={recordKey}` (Section 4.5.3): on a page that does not peek its own rows,
 * the record opens in the side peek, Open full goes to the record page, closing removes the parameter,
 * and a key for no readable record says so. Runs on the demo tenant seed (NWS-12 is the Production
 * Meeting record).
 */

test.use({ reducedMotion: "reduce" });

test("a record opens in the side peek from any route and closes back to the page", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/home?peek=NWS-12`);
  const peek = page.getByRole("dialog", { name: /Production Meeting/ });
  await expect(peek).toBeVisible();
  await expect(peek.getByText("NWS-12")).toBeVisible();
  await settled(page);

  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/home$`));

  await page.goto(`/${ORG}/activity?peek=NWS-12`);
  await expect(page.getByRole("dialog", { name: /Production Meeting/ })).toBeVisible();
  await page.getByRole("button", { name: "Open full page" }).click();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/r/NWS-12$`));
});

test("a key for no readable record names the problem and closes", async ({ page }) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/home?peek=NWS-99999`);
  const missing = page.getByTestId("shell-peek-missing");
  await expect(missing).toContainText("NWS-99999 is not a record you can open here");
  await settled(page);
  await missing.getByRole("button", { name: "Close" }).click();
  await expect(missing).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/home$`));
});

test("the command menu finds a record by key and opens it in the side peek (A59-015)", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/home`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  await settled(page);
  await page.keyboard.press("ControlOrMeta+k");
  const menu = page.getByRole("dialog").filter({ has: page.getByRole("combobox") });
  await expect(menu).toBeVisible({ timeout: 15_000 });

  // The common actions arrive from the server; one that opens a page shows that page's G shortcut.
  const openInbox = menu.getByRole("option", { name: /Open Inbox/ });
  await expect(openInbox).toBeVisible();
  await expect(openInbox.locator("kbd")).toHaveText(["G", "I"]);

  await page.keyboard.type("NWS-12");
  const hit = menu.getByRole("option", { name: /Production Meeting/ });
  await expect(hit).toBeVisible();
  await expect(hit).toContainText("NWS-12");
  await hit.click();
  await expect(page.getByRole("dialog", { name: /Production Meeting/ })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/home\\?peek=NWS-12$`));
});
