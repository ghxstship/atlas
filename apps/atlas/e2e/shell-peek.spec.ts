import { expect, test } from "./engine-test";
import { ORG, settled, signIn } from "./operations-support";

/**
 * The shell's global `?peek={recordKey}` (Section 4.5.3): on a page that does not peek its own rows,
 * the record opens in the side peek, Open full goes to the record page, closing removes the parameter,
 * a collection's full record page keeps the key to itself, and a key for no readable record says so.
 * Runs on the demo tenant seed (NWS-12 is the Production Meeting record, MH-001 an asset unit).
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

test("a collection's full record page keeps the shell's peek closed", async ({ page }) => {
  await signIn(page, "producer@example.com");
  // `?peek` here is the collection's own row (an asset tag), which it renders as its full page.
  await page.goto(`/${ORG}/assets/units?peek=MH-001&full=1`);
  await expect(page.getByRole("heading", { name: /MH-001/ })).toBeVisible();
  // The shell gives a collection page 600 ms to claim a key before it opens the record itself.
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId(/^shell-peek-/)).toHaveCount(0);
  await expect(page.getByText("is not a record you can open here")).toHaveCount(0);
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
