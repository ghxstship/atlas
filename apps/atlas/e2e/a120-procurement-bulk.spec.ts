import { expect as baseExpect, test, type Locator, type Page } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { expectAccessible } from "./support";

/**
 * A120 selection, bulk edit and row menus on procurement and vendors (RRR-165, A65-006, Section 11.7)
 * on the demo tenant:
 *   - two vendors change payment terms in one bulk transaction after a preview, and Cmd or Ctrl+Z
 *     undoes it through the server;
 *   - a purchase order preview names each order the change refuses, and nothing changes until
 *     every selected order can;
 *   - RFQ rows offer the bulk change in their menu, by right-click and by Shift+F10;
 *   - receipt rows have a menu but no selection, since a receipt has nothing to change in bulk.
 * The vendor change is undone and the purchase order change is never applied, so reruns see the
 * same data.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 30_000 });

async function table(page: Page, path: string): Promise<Locator> {
  await page.goto(`/${DEMO_ORG}/${path}?view=table`);
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();
  return grid.getByRole("row");
}

const text = async (cell: Locator) => (await cell.innerText()).trim();

test("vendors change payment terms in bulk, and undo", async ({ page }) => {
  await signInAs(page, "owner@example.com", DEMO_ORG);
  const rows = await table(page, "vendors/directory");
  const terms = (n: number) => rows.nth(n).locator('td[data-column="terms"]');
  const name = await text(rows.nth(1).locator('td[data-column="name"]'));
  const before = [await text(terms(1)), await text(terms(2))];

  await rows.nth(1).getByRole("checkbox").click();
  await rows
    .nth(2)
    .getByRole("checkbox")
    .click({ modifiers: ["Shift"] });
  await expect(page.getByRole("status").filter({ hasText: "2 selected" })).toBeAttached();
  await page
    .getByRole("toolbar", { name: "Bulk actions" })
    .getByRole("button", { name: "Change Payment terms" })
    .click();
  const dialog = page.getByRole("dialog", { name: /Change Payment terms on 2 rows/ });
  await expect(dialog).toBeVisible();
  const choice = dialog.getByLabel("New Payment terms");
  const options = await choice.locator("option").allInnerTexts();
  const target = options.find((o, i) => i > 0 && !before.includes(o.trim()))?.trim() ?? "";
  expect(target).not.toBe("");
  await choice.selectOption({ label: target });
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByText("2 rows will change.")).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Apply to 2 rows" }).click();
  await expect(page.getByText("Changed 2 rows.").first()).toBeVisible();
  await expect(terms(1)).toHaveText(target);
  await expect(terms(2)).toHaveText(target);

  // Cmd or Ctrl+Z sends the values before back through the same RPC.
  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByText("Undone: Changed 2 rows.")).toBeVisible();
  await expect(terms(1)).toHaveText(before[0] ?? "");
  await expect(terms(2)).toHaveText(before[1] ?? "");

  // A vendor's menu is named for the vendor, not its counterparty type.
  await rows.nth(1).locator('td[data-column="name"]').click({ button: "right" });
  const menu = page.getByRole("menu", { name: `Actions for ${name}` });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Change State" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a purchase order preview names the orders a change refuses, and applies nothing", async ({
  page,
}) => {
  await signInAs(page, "owner@example.com", DEMO_ORG);
  const rows = await table(page, "procurement/purchase-orders");
  const cellOf = (n: number, column: string) => rows.nth(n).locator(`td[data-column="${column}"]`);
  const keys = [await text(cellOf(1, "key")), await text(cellOf(2, "key"))];
  const states = [await text(cellOf(1, "state")), await text(cellOf(2, "state"))];

  // A click selects the first order and X, on the second order's row, adds it.
  await rows.nth(1).getByRole("checkbox").click();
  await cellOf(2, "key").focus();
  await page.keyboard.press("x");
  await expect(page.getByRole("status").filter({ hasText: "2 selected" })).toBeAttached();
  await page
    .getByRole("toolbar", { name: "Bulk actions" })
    .getByRole("button", { name: "Change State" })
    .click();
  const dialog = page.getByRole("dialog", { name: /Change State on 2 rows/ });

  // Only a Sent order closes and only an Approved order is sent, so whatever states the demo
  // orders are in, one of the two moves refuses at least one of them.
  const [target, from] = states.every((s) => s === "Sent")
    ? ["Sent", "Approved"]
    : ["Closed", "Sent"];
  const refused = keys.filter((_, i) => states[i] !== from);
  expect(refused.length).toBeGreaterThan(0);
  await dialog.getByLabel("New State").selectOption({ label: target });
  await dialog.getByLabel("Reason").fill("Weekly procurement review.");
  await dialog.getByRole("button", { name: "Preview" }).click();

  // Each refused order is named with the lifecycle's reason, and nothing can be applied.
  await expect(dialog.getByText(/rows? can't change/)).toBeVisible();
  for (const key of refused)
    await expect(dialog.getByText(`${key}: `, { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Apply to/ })).toHaveCount(0);
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(cellOf(1, "state")).toHaveText(states[0] ?? "");
  await expect(cellOf(2, "state")).toHaveText(states[1] ?? "");
});

test("RFQ and receipt rows open their menus", async ({ page }) => {
  await signInAs(page, "owner@example.com", DEMO_ORG);
  const rfqs = await table(page, "procurement/rfqs");
  const key = await text(rfqs.nth(1).locator('td[data-column="key"]'));
  await rfqs.nth(1).locator('td[data-column="title"]').click({ button: "right" });
  const menu = page.getByRole("menu", { name: `Actions for ${key}` });
  await expect(menu).toBeVisible();
  // Select carries its X shortcut in its accessible name.
  for (const item of [/^Open$/, /^Select\b/, /^Change State$/]) {
    await expect(menu.getByRole("menuitem", { name: item })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await rfqs.nth(1).locator('td[data-column="title"]').focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");

  const receipts = await table(page, "procurement/receipts");
  await expect(receipts.nth(1).getByRole("checkbox")).toHaveCount(0);
  const order = await text(receipts.nth(1).locator('td[data-column="order"]'));
  await receipts.nth(1).locator('td[data-column="vendor"]').click({ button: "right" });
  const receiptMenu = page.getByRole("menu", { name: `Actions for ${order}` });
  await expect(receiptMenu.getByRole("menuitem", { name: "Open", exact: true })).toBeVisible();
  await expect(receiptMenu.getByRole("menuitem", { name: /^Select\b/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
});
