import { expect, test, type Browser, type Page } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * A88 collaboration and power editing (RRR-133, A65-006, ADR 0044) on the demo tenant:
 *   - two people edit one SOP together and both editors converge on both edits, which reach the row;
 *   - a selection of records changes owner in one bulk transaction after a preview, Cmd or Ctrl+Z
 *     undoes it through the server, and the record's field history shows both changes;
 *   - a second person's list updates live, without a reload;
 *   - a row's context menu opens by right-click and by Shift+F10.
 * Each run makes its own SOP, so reruns never collide.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
expect.configure({ timeout: 30_000 });

async function asPerson(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signInAs(page, email, DEMO_ORG);
  return page;
}

/** The live editor's text box once the shared document has loaded. */
async function openEditor(page: Page) {
  await page.getByRole("button", { name: "Edit together" }).click();
  const editor = page.getByRole("textbox", { name: "Procedure" });
  await expect(editor).toBeVisible();
  return editor;
}

test("two people edit an SOP together and converge", async ({ browser }) => {
  const id = uniqueId();
  const owner = await asPerson(browser, "owner@example.com");
  await owner.goto(`/${DEMO_ORG}/knowledge/sops?create=1`);
  await owner.getByLabel("Title", { exact: true }).fill(`Working at Height ${id}`);
  await owner.getByLabel("Procedure", { exact: true }).fill(`Wear a harness ${id}.`);
  await owner.getByRole("button", { name: "New SOP" }).last().click();
  await owner.waitForURL(/peek=/);
  const full = `${owner.url()}&full=1`;
  await owner.goto(full);

  const admin = await asPerson(browser, "admin@example.com");
  await admin.goto(full);

  const first = await openEditor(owner);
  const second = await openEditor(admin);
  await expect(first).toContainText(`Wear a harness ${id}.`);
  await expect(second).toContainText(`Wear a harness ${id}.`);

  await first.click();
  await owner.keyboard.press("End");
  await owner.keyboard.type(" Alpha-one.");
  await second.click();
  await admin.keyboard.press("End");
  await admin.keyboard.type(" Beta-two.");

  // Both editors hold both edits: Yjs merged them, whichever arrived first.
  for (const editor of [first, second]) {
    await expect(editor).toContainText("Alpha-one.");
    await expect(editor).toContainText("Beta-two.");
  }
  const one = (await first.innerText()).trim();
  await expect.poll(async () => (await second.innerText()).trim()).toBe(one);
  await expectAccessible(owner);

  // Pausing writes the merged text into the SOP, so a reader without the editor sees it.
  await owner.getByRole("button", { name: "Done" }).click();
  await expect
    .poll(
      async () => {
        await owner.reload();
        return owner.locator("#sop-body").innerText();
      },
      { timeout: 60_000, intervals: [3_000] },
    )
    .toMatch(/Alpha-one\.[\s\S]*Beta-two\.|Beta-two\.[\s\S]*Alpha-one\./);
  await owner.context().close();
  await admin.context().close();
});

test("bulk edit, undo, field history, live lists and row menus", async ({ browser }) => {
  const owner = await asPerson(browser, "owner@example.com");
  const table = `/${DEMO_ORG}/work/all-records?view=table`;
  await owner.goto(table);
  const grid = owner.getByRole("grid");
  await expect(grid).toBeVisible();
  const rows = grid.getByRole("row");
  const ownerCell = (n: number) => rows.nth(n).locator('td[data-column="owner"]');
  const keyOf = async (n: number) =>
    (await rows.nth(n).locator('td[data-column="key"]').innerText()).trim();
  const firstKey = await keyOf(1);
  const before = [(await ownerCell(1).innerText()).trim(), (await ownerCell(2).innerText()).trim()];

  // A second person watches the same list.
  const admin = await asPerson(browser, "admin@example.com");
  await admin.goto(table);
  await expect(admin.getByRole("grid")).toBeVisible();

  // Select two rows and preview the change.
  await rows.nth(1).getByRole("checkbox").click();
  await rows
    .nth(2)
    .getByRole("checkbox")
    .click({ modifiers: ["Shift"] });
  await expect(owner.getByRole("status").filter({ hasText: "2 selected" })).toBeAttached();
  await owner
    .getByRole("toolbar", { name: "Bulk actions" })
    .getByRole("button", { name: "Change Owner" })
    .click();
  const dialog = owner.getByRole("dialog", { name: /Change Owner on 2 rows/ });
  await expect(dialog).toBeVisible();
  const choice = dialog.getByLabel("New Owner");
  const options = await choice.locator("option").allInnerTexts();
  const target = options.find((o, i) => i > 0 && !before.includes(o.trim()))?.trim() ?? "";
  expect(target).not.toBe("");
  await choice.selectOption({ label: target });
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByText(/rows? will change\./)).toBeVisible();
  await expectAccessible(owner);
  await dialog.getByRole("button", { name: /Apply to \d+ rows?/ }).click();
  await expect(owner.getByText(/Changed \d+ rows?\./).first()).toBeVisible();
  await expect(ownerCell(1)).toHaveText(target);
  await expect(ownerCell(2)).toHaveText(target);

  // The other person's list follows without a reload.
  const adminGrid = admin.getByRole("grid");
  await expect(
    adminGrid.getByRole("row").filter({ hasText: firstKey }).locator('td[data-column="owner"]'),
  ).toHaveText(target, { timeout: 45_000 });

  // Cmd or Ctrl+Z undoes the change through the server.
  await owner.getByRole("heading", { level: 1 }).click();
  await owner.keyboard.press("ControlOrMeta+z");
  await expect(owner.getByText(/Undone: Changed \d+ rows?\./)).toBeVisible();
  await expect(ownerCell(1)).toHaveText(before[0] ?? "");
  await expect(ownerCell(2)).toHaveText(before[1] ?? "");

  // A row's menu: right-click, then Shift+F10 from the keyboard.
  await rows.nth(1).locator('td[data-column="title"]').click({ button: "right" });
  const menu = owner.getByRole("menu", { name: `Actions for ${firstKey}` });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Open", exact: true })).toBeVisible();
  await owner.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await rows.nth(1).locator('td[data-column="title"]').focus();
  await owner.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await owner.keyboard.press("Escape");

  // The record's field history shows the change and its undo.
  await owner.goto(`/${DEMO_ORG}/r/${encodeURIComponent(firstKey)}`);
  const history = owner
    .getByRole("region", { name: "Field history" })
    .or(owner.locator('section[aria-labelledby^="field-history-"]'));
  await expect(history.first()).toContainText("Owner");
  await expect(history.first()).toContainText(target);
  await owner.context().close();
  await admin.context().close();
});
