import { expect, test } from "./engine-test";
import { ORG, settled, signIn } from "./operations-support";

/**
 * The shell's global `?peek={recordKey}` (Section 4.5.3): on a page that does not peek its own rows,
 * the record opens in the side peek, Open full goes to the record page, closing removes the parameter,
 * a collection keeps its own rows (peek or full page, however slow) and hands over a key it has no
 * row for, and a key for no readable record says so. Runs on the demo tenant seed (NWS-12 is the
 * Production Meeting record, MH-001 an asset unit).
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
  // Leave the shell time it would need to open the key, had it taken it from the page.
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId(/^shell-peek-/)).toHaveCount(0);
  await expect(page.getByText("is not a record you can open here")).toHaveCount(0);
});

test("a row opened by a click stays the collection's while its peek is slow to load", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/assets/units?view=list`);
  await expect(page.getByRole("heading", { level: 1, name: "Units" })).toBeVisible();
  await settled(page);
  // Hold the server render of the peek for 1.5 s, as on a slow network: the URL moves to `?peek`
  // under the section's loading state long before the page's own panel arrives.
  await page.route(
    (url) => url.pathname === `/${ORG}/assets/units` && url.searchParams.has("peek"),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.fallback();
    },
  );
  await page
    .getByRole("row")
    .filter({ hasText: "MH-001" })
    .getByRole("button", { name: "Open" })
    .first()
    .click();
  await expect(page.getByRole("dialog", { name: /MH-001/ })).toBeVisible();
  await expect(page.getByTestId(/^shell-peek-/)).toHaveCount(0);
  await expect(page.getByText("is not a record you can open here")).toHaveCount(0);
});

test("a collection hands the shell a key it has no row for", async ({ page }) => {
  await signIn(page, "owner@example.com");
  // NWS-12 is a work record, not a vendor: the directory hands it over and the shell opens it.
  await page.goto(`/${ORG}/vendors/directory?peek=NWS-12`);
  const peek = page.getByRole("dialog", { name: /Production Meeting/ });
  await expect(peek).toBeVisible();
  await expect(peek.getByText("NWS-12")).toBeVisible();
  await settled(page);
  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/vendors/directory$`));
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
