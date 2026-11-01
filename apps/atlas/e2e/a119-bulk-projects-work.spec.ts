import { expect as baseExpect, test, type Locator, type Page } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * A119 selection, bulk edit and row menus (RRR-164, Section 11.7, ADR 0078) on the demo tenant:
 *   - two projects selected with a click and Shift+click change venue in one previewed transaction,
 *     and Cmd or Ctrl+Z puts both venues back through the server;
 *   - two work orders made by this run move to Open for Bids together and back to Draft on undo;
 *   - a Draft work order deleted from its row menu goes to Trash, and the Undo toast restores it.
 * The work orders carry a unique title, so reruns never collide.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 30_000 });

/** Selects grid rows 1 and 2 (row 0 is the header): a click on the first, Shift+click on the second. */
async function selectFirstTwo(page: Page, rows: Locator) {
  await rows.nth(1).getByRole("checkbox").click();
  await rows
    .nth(2)
    .getByRole("checkbox")
    .click({ modifiers: ["Shift"] });
  await expect(page.getByRole("status").filter({ hasText: "2 selected" })).toBeAttached();
}

/** Opens the bulk bar's Change {field} dialog for the selection. */
async function changeDialog(page: Page, field: string): Promise<Locator> {
  await page
    .getByRole("toolbar", { name: "Bulk actions" })
    .getByRole("button", { name: `Change ${field}` })
    .click();
  const dialog = page.getByRole("dialog", { name: new RegExp(`Change ${field} on 2 rows`) });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Undoes the latest action with the keyboard, away from any field. */
async function undo(page: Page) {
  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press("ControlOrMeta+z");
}

test("projects: select two, change venue in bulk, undo", async ({ page }) => {
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/projects/all?view=table`);
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();
  const rows = grid.getByRole("row");
  const venue = (n: number) => rows.nth(n).locator('td[data-column="venue"]');
  const before = [(await venue(1).innerText()).trim(), (await venue(2).innerText()).trim()];

  await selectFirstTwo(page, rows);
  const dialog = await changeDialog(page, "Venue");
  const choice = dialog.getByLabel("New Venue");
  const options = (await choice.locator("option").allInnerTexts()).map((o) => o.trim());
  // A venue neither project has, so both rows change.
  const target = options.find((o, i) => i > 0 && !before.includes(o)) ?? "";
  expect(target).not.toBe("");
  await choice.selectOption({ label: target });
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByText("2 rows will change.")).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Apply to 2 rows" }).click();
  await expect(page.getByText("Changed 2 rows.").first()).toBeVisible();
  await expect(venue(1)).toHaveText(target);
  await expect(venue(2)).toHaveText(target);

  await undo(page);
  await expect(page.getByText("Undone: Changed 2 rows.")).toBeVisible();
  await expect(venue(1)).toHaveText(before[0] ?? "");
  await expect(venue(2)).toHaveText(before[1] ?? "");

  // A row's menu offers the same change as the bar, from the keyboard too.
  const key = (await rows.nth(1).locator('td[data-column="key"]').innerText()).trim();
  await rows.nth(1).locator('td[data-column="name"]').focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: `Actions for ${key}` });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Change Venue" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("work orders: move two in bulk and undo, then delete a draft and restore it", async ({
  page,
}) => {
  const id = uniqueId();
  await signInAs(page, "owner@example.com", DEMO_ORG);
  for (const title of [`Rig the Truss ${id}`, `Set the Barricades ${id}`]) {
    await page.goto(`/${DEMO_ORG}/work/work-orders?create=1`);
    const sheet = page.getByRole("dialog", { name: "New work order" });
    await sheet.getByLabel("Title").fill(title);
    await sheet.getByRole("button", { name: "Create work order" }).click();
    await page.waitForURL(/peek=/);
  }

  await page.goto(`/${DEMO_ORG}/work/work-orders?view=table&q=${id}`);
  const grid = page.getByRole("grid");
  const rows = grid.getByRole("row");
  await expect(rows).toHaveCount(3);
  const state = (n: number) => rows.nth(n).locator('td[data-column="state"]');
  await expect(state(1)).toHaveText("Draft");
  await expect(state(2)).toHaveText("Draft");

  await selectFirstTwo(page, rows);
  const dialog = await changeDialog(page, "State");
  await dialog.getByLabel("New State").selectOption({ label: "Open for Bids" });
  await dialog.getByLabel("Reason").fill("Bids invited from the rigging pool.");
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByText("2 rows will change.")).toBeVisible();
  await dialog.getByRole("button", { name: "Apply to 2 rows" }).click();
  await expect(page.getByText("Changed 2 rows.").first()).toBeVisible();
  await expect(state(1)).toHaveText("Open for Bids");
  await expect(state(2)).toHaveText("Open for Bids");

  await undo(page);
  await expect(page.getByText("Undone: Changed 2 rows.")).toBeVisible();
  await expect(state(1)).toHaveText("Draft");
  await expect(state(2)).toHaveText("Draft");

  // Delete a draft from its row menu: it goes to Trash, and the toast's Undo restores it.
  const key = (await rows.nth(1).locator('td[data-column="key"]').innerText()).trim();
  await rows.nth(1).locator('td[data-column="title"]').click({ button: "right" });
  const menu = page.getByRole("menu", { name: `Actions for ${key}` });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Delete draft" }).click();
  const notices = page.getByRole("region", { name: "Undo notifications" });
  await expect(notices.getByText(`${key} moved to Trash.`)).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expectAccessible(page);
  await notices.getByRole("button", { name: /Undo/ }).click();
  await expect(page.getByText(`Undone: ${key} moved to Trash.`)).toBeVisible();
  await expect(rows).toHaveCount(3);
  await expect(grid.getByText(key, { exact: true })).toBeVisible();
});
