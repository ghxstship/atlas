import { expect, selectAllText, settle, test, type Locator, type Page } from "./engine-test";
import { sendCrewAgreement } from "./fixtures";
import { DEMO, expectAccessible, signIn } from "./support";

/**
 * Opens the command menu with Cmd or Ctrl+K. Signing in lands on Home by a client-side navigation, so
 * the page's load state is already idle while Home's scripts still load, and a shortcut pressed before
 * the frame has its key listener is lost: in WebKit on Linux, Meta+K went 1 ms after the wait and
 * fetched no menu, while Home's chunks were still arriving. The shortcut is pressed again only while
 * the menu is closed, since a second press of one that arrived would close it.
 */
async function openMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole("dialog").filter({ has: page.getByRole("combobox") });
  await expect(async () => {
    if (!(await menu.isVisible())) await page.keyboard.press("ControlOrMeta+k");
    await expect(menu).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  return menu;
}

/**
 * Search first in Gateway (Section 11.10 item 1, trace S11.10-02, A126): Cmd or Ctrl+K finds the person's
 * own documents and messages, not only pages, and the search field on Home finds the same things as the
 * person types. The results come from app.gateway_search, which returns only what the person reads in
 * Gateway; the menu and the search load on first use, never with the page.
 */
test("Cmd or Ctrl+K finds a document and a message, and opens each", async ({ page }) => {
  const agreement = await sendCrewAgreement();
  await signIn(page, "crew@example.com");
  await settle(page);

  const menu = await openMenu(page);
  await page.keyboard.type(agreement.title);
  const document = menu.getByRole("option", {
    name: new RegExp(`^${agreement.title} · Agreement`),
  });
  // The first search compiles the server action on a cold development server.
  await expect(document).toBeVisible({ timeout: 15_000 });
  await expectAccessible(page);
  await document.click();
  await expect(page).toHaveURL(
    new RegExp(`/work/engagements/${DEMO.crewEngagementKey}/documents$`),
  );
  await expect(page.getByText(agreement.title).first()).toBeVisible();

  await openMenu(page);
  await page.keyboard.type("open most weekends");
  const message = menu.getByRole("option", { name: /Availability for the Fall Season: / });
  await expect(message).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/messages\/THR-/);
  await expect(page.getByText("I am open most weekends in November")).toBeVisible();
});

test("the menu finds a setting and an action by their words", async ({ page }) => {
  await signIn(page, "crew@example.com");
  await settle(page);
  const menu = await openMenu(page);
  await page.keyboard.type("time zone");
  await expect(
    menu.getByRole("group", { name: "Settings" }).getByRole("option").first(),
  ).toBeVisible({ timeout: 15_000 });
  await selectAllText(page);
  await page.keyboard.type("sign documents");
  await expect(menu.getByRole("option", { name: "Sign documents" })).toBeVisible();
});

test("Home's search field finds the person's message as they type", async ({ page }) => {
  await signIn(page, "crew@example.com");
  const search = page.getByRole("searchbox", { name: "Search Gateway" });
  await search.fill("weekends November");
  const results = page.getByRole("navigation", { name: "Search results" });
  const message = results.getByRole("link", { name: /Availability for the Fall Season/ });
  await expect(message).toBeVisible({ timeout: 15_000 });
  await expect(results.getByRole("link", { name: /Search opportunities for/ })).toBeVisible();
  await expectAccessible(page);
  await message.click();
  await expect(page).toHaveURL(/\/messages\/THR-/);
});
