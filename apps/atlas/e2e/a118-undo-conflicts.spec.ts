import {
  expect as baseExpect,
  settle as settleNetwork,
  test,
  type Browser,
  type Page,
} from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * A118 undo and conflicts (RRR-163, A65-006, ADR 0077) on the demo tenant:
 *   - a record property edit goes on the undo stack: Cmd or Ctrl+Z undoes it through the server and Shift redoes it;
 *   - a record moved to Trash shows in Activity, which restores it;
 *   - two people save the same property: the later save opens the mine-or-theirs dialog with both values, and
 *     keeping mine saves it.
 * Each run makes its own records, so reruns never collide.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 30_000 });

async function asPerson(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signInAs(page, email, DEMO_ORG);
  return page;
}

/** Creates a Task through the New record sheet and returns its key from the peek. */
async function createTask(page: Page, title: string): Promise<string> {
  await page.goto(`/${DEMO_ORG}/work/all-records?create=1`);
  const sheet = page.getByRole("dialog", { name: "New record" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Kind").selectOption("Task");
  await sheet.getByLabel("Subtype").selectOption("Execute");
  await sheet.getByLabel("Title").fill(title);
  await sheet.getByRole("button", { name: "Create record" }).click();
  await page.waitForURL(/peek=/);
  return new URL(page.url()).searchParams.get("peek") ?? "";
}

/** The record page, once its on-load work is done (A71). */
async function openRecord(page: Page, key: string) {
  await page.goto(`/${DEMO_ORG}/r/${encodeURIComponent(key)}`);
  await settleNetwork(page);
  return page.getByRole("form", { name: "Edit record" });
}

test("an inline property edit undoes and redoes with Cmd or Ctrl+Z", async ({ browser }) => {
  const id = uniqueId();
  const owner = await asPerson(browser, "owner@example.com");
  const before = `Hang the banner ${id}`;
  const after = `Hang two banners ${id}`;
  const key = await createTask(owner, before);
  const form = await openRecord(owner, key);

  await form.getByLabel("Title", { exact: true }).fill(after);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("status")).toHaveText("Saved.");
  await expect(owner.getByRole("heading", { level: 1, name: after })).toBeVisible();

  // Outside a text field, Cmd or Ctrl+Z is the stack's.
  await owner.getByRole("heading", { level: 1 }).click();
  await owner.keyboard.press("ControlOrMeta+z");
  await expect(owner.getByText(`Undone: Edited ${key}.`)).toBeVisible();
  await expect(owner.getByRole("heading", { level: 1, name: before })).toBeVisible();
  await expect(form.getByLabel("Title", { exact: true })).toHaveValue(before);

  await owner.keyboard.press("ControlOrMeta+Shift+z");
  await expect(owner.getByText(`Redone: Edited ${key}.`)).toBeVisible();
  await expect(owner.getByRole("heading", { level: 1, name: after })).toBeVisible();
  await expectAccessible(owner);
  await owner.context().close();
});

test("a record moved to Trash is restored from Activity", async ({ browser }) => {
  const id = uniqueId();
  const owner = await asPerson(browser, "owner@example.com");
  const title = `Pack the cable trunks ${id}`;
  const key = await createTask(owner, title);
  await openRecord(owner, key);
  await owner.getByRole("button", { name: "Move to Trash" }).click();
  await expect(owner.getByText(`${key} moved to Trash.`).first()).toBeVisible();
  await expect(owner.getByText("This record is in Trash.").first()).toBeVisible();

  await owner.goto(`/${DEMO_ORG}/activity/feed`);
  const restore = owner.getByRole("button", { name: `Restore ${key} ${title}` });
  await expect(restore).toBeVisible();
  await expectAccessible(owner);
  await restore.click();
  await expect(
    owner.getByRole("status").filter({ hasText: `Restored ${key} ${title}.` }),
  ).toBeVisible();
  await expect(restore).toHaveCount(0);

  await openRecord(owner, key);
  await expect(owner.getByRole("button", { name: "Move to Trash" })).toBeVisible();
  await owner.context().close();
});

test("two people save the same property and the later one chooses mine or theirs", async ({
  browser,
}) => {
  const id = uniqueId();
  const owner = await asPerson(browser, "owner@example.com");
  const key = await createTask(owner, `Rig the truss ${id}`);
  const mine = `Rig two trusses ${id}`;
  const theirs = `Rig the truss safely ${id}`;

  const admin = await asPerson(browser, "admin@example.com");
  const ownerForm = await openRecord(owner, key);
  const adminForm = await openRecord(admin, key);

  await adminForm.getByLabel("Title", { exact: true }).fill(theirs);
  await adminForm.getByRole("button", { name: "Save" }).click();
  await expect(adminForm.getByRole("status")).toHaveText("Saved.");

  // The owner started from the old title; their save would overwrite the admin's.
  await ownerForm.getByLabel("Title", { exact: true }).fill(mine);
  await ownerForm.getByRole("button", { name: "Save" }).click();
  const dialog = owner.getByRole("dialog", { name: `${key} changed while you edited it` });
  await expect(dialog).toBeVisible();
  const row = dialog.getByRole("row", { name: /Title/ });
  await expect(row).toContainText(mine);
  await expect(row).toContainText(theirs);
  await expectAccessible(owner);

  await dialog.getByRole("button", { name: "Keep mine" }).click();
  await expect(dialog).toBeHidden();
  await expect(ownerForm.getByRole("status")).toHaveText("Saved.");
  await expect(owner.getByRole("heading", { level: 1, name: mine })).toBeVisible();
  await admin.reload();
  await expect(admin.getByRole("heading", { level: 1, name: mine })).toBeVisible();
  await owner.context().close();
  await admin.context().close();
});
