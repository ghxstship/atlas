import { expect as baseExpect, settle as settleNetwork, test, type Page } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A133 (Section 11.11, S11.11-01): drag to reschedule on the timeline with a dependency preview.
 * A record moved by keyboard (arrows, then Enter) and one moved by pointer (a drag, then Apply)
 * each show which successors move and whether the critical path changes before anything is
 * written, nothing applies before the server has previewed the change, and the commit lands what
 * the preview showed, successors included. Each run signs up a
 * new owner in a new org on the local stack.
 */

test.use({ reducedMotion: "reduce" });
// Applying waits on a server action that re-renders the org's pages (A71 allows 20 seconds).
const expect = baseExpect.configure({ timeout: 20_000 });

async function newOwnerOrg(page: Page): Promise<string> {
  const id = uniqueId();
  const slug = `tlr-${id}`;
  await signUp(page, { name: "Sam Scheduler", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Timeline ${id}`, slug });
  return slug;
}

async function createProject(page: Page, slug: string, key: string, name: string) {
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill(key);
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "More fields" }).click();
  await dialog.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await dialog.getByLabel("Tier of experience").selectOption({ index: 5 });
  await dialog.getByLabel("First production day").fill("2027-03-12");
  await dialog.getByLabel("Last production day").fill("2027-03-15");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/${key}/overview`);
}

async function createTask(page: Page, slug: string, title: string, due: string): Promise<string> {
  await page.goto(`/${slug}/work/all-records?create=1`);
  const sheet = page.getByRole("dialog", { name: "New record" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Kind").selectOption("Task");
  await sheet.getByLabel("Subtype").selectOption("Execute");
  await sheet.getByLabel("Title").fill(title);
  await sheet.getByLabel("Due").fill(due);
  await sheet.getByRole("button", { name: "Create record" }).click();
  await page.waitForURL(/peek=/);
  return new URL(page.url()).searchParams.get("peek") ?? "";
}

/** The record's due time as its edit form shows it, on the project's calendar. */
async function dueOf(page: Page, slug: string, key: string): Promise<string> {
  await page.goto(`/${slug}/r/${key}`);
  await page
    .getByRole("form", { name: "Edit record" })
    .getByRole("button", { name: "More fields" })
    .click();
  return page.getByLabel("Due", { exact: true }).inputValue();
}

test("journey: reschedule on the timeline by keyboard and by drag, with a dependency preview", async ({
  page,
}) => {
  const slug = await newOwnerOrg(page);
  await createProject(page, slug, "TLR", "Tour Load-In");
  const first = await createTask(page, slug, "Hang the truss", "2027-03-12T10:00");
  const second = await createTask(page, slug, "Focus the lights", "2027-03-13T10:00");
  await page.goto(`/${slug}/r/${second}`);
  await page.getByLabel("Add a predecessor").selectOption({ label: `${first} Hang the truss` });
  await page.getByRole("button", { name: "Add dependency" }).click();
  await expect(page.getByRole("region", { name: "Dependencies" })).toContainText(
    `${first} Hang the truss`,
  );

  // Keyboard: focus the first record's bar, move it two days, read the preview, apply with Enter.
  await page.goto(`/${slug}/schedule/timeline`);
  const bar = page.getByRole("button", { name: new RegExp(`^${first} Hang the truss`) });
  await expect(bar).toBeVisible();
  await settleNetwork(page);
  await bar.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const preview = page.getByRole("group", { name: "Reschedule preview" });
  await expect(preview).toContainText(`${first} moves to`);
  await expect(preview).toContainText(`1 successor moves: ${second}.`);
  await expect(preview).toContainText(/The critical path (changes|stays the same)\./);
  // The server's own preview replaces the estimate before anything can be applied.
  await expect(preview).not.toContainText("Checking every dependency");
  await expect(preview).toContainText(`1 successor moves: ${second}.`);
  await expectAccessible(page);
  await page.keyboard.press("Enter");
  await expect(preview).toBeHidden();
  expect(await dueOf(page, slug, first)).toBe("2027-03-14T10:00");
  // The successor was pushed one day, the least that keeps it after its predecessor.
  expect(await dueOf(page, slug, second)).toBe("2027-03-14T10:00");

  // Pointer: drag the successor two days later, then Apply: two interactions.
  await page.goto(`/${slug}/schedule/timeline`);
  const successor = page.getByRole("button", { name: new RegExp(`^${second} Focus the lights`) });
  await expect(successor).toBeVisible();
  await settleNetwork(page);
  const box = await successor.boundingBox();
  if (!box) throw new Error("The successor's bar has no box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 32, y, { steps: 4 });
  await page.mouse.move(x + 64, y, { steps: 4 });
  await page.mouse.up();
  await expect(preview).toContainText(`${second} moves to`);
  await expect(preview).toContainText("No other record moves.");
  // Apply may be pressed before the server's preview lands; it applies once that preview agrees.
  await preview.getByRole("button", { name: "Apply" }).click();
  await expect(preview).toBeHidden();
  expect(await dueOf(page, slug, second)).toBe("2027-03-16T10:00");
  expect(await dueOf(page, slug, first)).toBe("2027-03-14T10:00");
});
