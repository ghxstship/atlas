import type { Locator, Page } from "@playwright/test";
import { expect, settle, test } from "./engine-test";
import { ORG, signIn } from "./operations-support";
import { expectAccessible } from "./support";

/**
 * A115 hover cards and record menus (RRR-160, Section 11.7, A65-006) on the demo tenant seed, where
 * the Producer owns NWS-14 Fire Marshal Walk (due in March 2027): a record previews after 400 ms on
 * its key in the list, table, board and calendar of My Work, from the keyboard too, and a board card
 * and a calendar event open the record's menu as a table row does. Shift and invoice rows and the
 * records a record page names preview too, and a record page's title row opens the record's menu.
 */

test.use({ reducedMotion: "reduce" });
test.describe.configure({ timeout: 180_000 });

const KEY = "NWS-14";
const TITLE = "Fire Marshal Walk";

/** Hovers a part and checks the card waits 400 ms and then names the record. */
async function previews(page: Page, part: Locator, text: string | RegExp) {
  const card = page.getByRole("tooltip");
  await expect(card).toHaveCount(0);
  const started = Date.now();
  await part.hover();
  await expect(card).toBeVisible();
  expect(Date.now() - started, "the card waits 400 ms").toBeGreaterThanOrEqual(400);
  await expect(card).toContainText(text);
  // Leaving closes it.
  await page.getByRole("heading", { level: 1 }).hover();
  await expect(card).toHaveCount(0);
}

test("a record previews after 400 ms in the list, table, board and calendar of My Work", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");

  await page.goto(`/${ORG}/my-work`);
  await settle(page);
  const row = page.getByRole("row", { name: new RegExp(TITLE) });
  await previews(page, row.locator('[data-column="key"]'), TITLE);
  // From the keyboard: the focused row previews its key, described by the card; Esc closes it.
  await row.focus();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText(KEY);
  await expect(row).toHaveAttribute("aria-describedby", (await card.getAttribute("id")) ?? "");
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  await page.goto(`/${ORG}/my-work?view=table`);
  await settle(page);
  const cell = page
    .getByRole("grid")
    .locator('td[data-column="key"]')
    .filter({ hasText: new RegExp(`^\\s*${KEY}\\s*$`) });
  await previews(page, cell, TITLE);

  await page.goto(`/${ORG}/my-work?view=board`);
  await settle(page);
  const boardCard = page.getByRole("button", { name: new RegExp(`${KEY} ${TITLE}`) });
  await previews(page, boardCard.locator('[data-column="key"]'), TITLE);
  // The card's menu is the record's menu, as on its table row.
  await boardCard.click({ button: "right" });
  const menu = page.getByRole("menu", { name: `Actions for ${KEY}` });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Open", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  await page.goto(`/${ORG}/my-work?view=calendar&month=2027-03`);
  await settle(page);
  const event = page.getByRole("button", { name: new RegExp(`${KEY} ${TITLE}`) });
  await previews(page, event, TITLE);
  await event.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("shift and invoice rows and a record page's related keys preview, and its title row opens the record's menu", async ({
  page,
}) => {
  await signIn(page, "owner@example.com");

  // A shift previews with its project, person and time (the demo shifts work the week of March 8, 2027).
  await page.goto(`/${ORG}/crew/shifts?view=table&week=2027-03-08`);
  await settle(page);
  const shift = page.getByRole("grid").first().locator('td[data-column="project"]').first();
  await previews(page, shift, (await shift.innerText()).trim());

  // An invoice previews on its number.
  await page.goto(`/${ORG}/finance/invoices?view=table`);
  await settle(page);
  const invoice = page.getByRole("grid").locator('td[data-column="number"]').first();
  await previews(page, invoice, (await invoice.innerText()).trim());

  // A record page previews the records it depends on, read by their key: NWS-3 Hang the main truss
  // follows NWS-2 Install the stage deck. Activity lines read their record's key the same way.
  await page.goto(`/${ORG}/r/NWS-3`);
  await settle(page);
  await previews(
    page,
    page.locator('[data-item="NWS-2"][data-column="key"]'),
    "Install the stage deck",
  );

  // The title row opens the record's menu, without Open as a full page.
  const titleRow = page.locator("[data-record-title-row]");
  await titleRow.getByText("NWS-3", { exact: true }).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for NWS-3" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Change State" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Open as a full page" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await titleRow.getByRole("button", { name: "Actions for NWS-3" }).click();
  await expect(menu).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press("Escape");
});
