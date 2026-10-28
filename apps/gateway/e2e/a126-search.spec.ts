import { expect, settle, test } from "./engine-test";
import { sendCrewAgreement } from "./fixtures";
import { DEMO, expectAccessible, signIn } from "./support";

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

  await page.keyboard.press("ControlOrMeta+k");
  const menu = page.getByRole("dialog").filter({ has: page.getByRole("combobox") });
  await expect(menu).toBeVisible();
  await page.keyboard.type(agreement.title);
  const document = menu.getByRole("option", { name: new RegExp(`^${agreement.title} · Agreement`) });
  await expect(document).toBeVisible();
  await expectAccessible(page);
  await document.click();
  await expect(page).toHaveURL(
    new RegExp(`/work/engagements/${DEMO.crewEngagementKey}/documents$`),
  );
  await expect(page.getByText(agreement.title).first()).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  await expect(menu).toBeVisible();
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
  await page.keyboard.press("ControlOrMeta+k");
  const menu = page.getByRole("dialog").filter({ has: page.getByRole("combobox") });
  await expect(menu).toBeVisible();
  await page.keyboard.type("time zone");
  await expect(menu.getByRole("group", { name: "Settings" }).getByRole("option").first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("sign documents");
  await expect(menu.getByRole("option", { name: "Sign documents" })).toBeVisible();
});

test("Home's search field finds the person's message as they type", async ({ page }) => {
  await signIn(page, "crew@example.com");
  const search = page.getByRole("searchbox", { name: "Search Gateway" });
  await search.fill("weekends November");
  const results = page.getByRole("navigation", { name: "Search results" });
  const message = results.getByRole("link", { name: /Availability for the Fall Season/ });
  await expect(message).toBeVisible();
  await expect(results.getByRole("link", { name: /Search opportunities for/ })).toBeVisible();
  await expectAccessible(page);
  await message.click();
  await expect(page).toHaveURL(/\/messages\/THR-/);
});
