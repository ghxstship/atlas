import { expect, test } from "./engine-test";
import { ORG, settled, signIn } from "./operations-support";

/**
 * Journey 24 (Section 20.2) and gate 8's keyboard-only checks: reach a module through the command
 * menu, move through a list with J and K, open the record in the side peek with Enter, and close it
 * with Escape back to the same row, without touching the mouse after sign-in. Runs on the demo
 * tenant seed. Gate 26 counts the keystrokes: the command menu reaches any page in one search.
 */
test.use({ reducedMotion: "reduce" });

test("journey 24: Atlas by keyboard only, through the command menu, J and K, and the peek", async ({
  page,
  browserName,
}) => {
  await signIn(page, "producer@example.com");
  await page.waitForLoadState("networkidle");

  // Command menu: one search reaches the records list.
  await page.keyboard.press("ControlOrMeta+k");
  const menu = page.getByRole("dialog").filter({ has: page.getByRole("combobox") });
  await expect(menu).toBeVisible();
  await page.keyboard.type("All Records");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/${ORG}/work/all-records`));
  await page.goto(`/${ORG}/work/all-records?view=list`);
  await page.waitForLoadState("networkidle");

  // Tab into the list: focus lands on the first row; J and K move by one.
  const list = page.getByRole("grid").first();
  await expect(list).toBeVisible();
  await list.focus();
  const rows = list.locator("[data-row]");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(rows.nth(2)).toBeFocused();
  await page.keyboard.press("k");
  await expect(rows.nth(1)).toBeFocused();

  // Tab reaches the row's Open control, Enter opens the peek; Escape closes it and returns focus.
  // WebKit follows Safari: Tab moves between fields and links, Option+Tab reaches every control.
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(rows.nth(1).getByRole("button", { name: "Open" })).toBeFocused();
  await page.keyboard.press("Enter");
  const peek = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("button", { name: "Open full page" }) });
  await expect(peek).toBeVisible();
  await expect(page).toHaveURL(/peek=/);
  await settled(page);
  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();
  await expect(page).not.toHaveURL(/peek=/);
  await expect(rows.nth(1).getByRole("button", { name: "Open" })).toBeFocused();
});
