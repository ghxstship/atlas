import { expect as baseExpect, settle, test } from "./engine-test";
import { expectAccessible } from "./support";
import { addDependency, createProject, createTask, dueOf, newOwnerOrg } from "./p8-support";

/**
 * P8 (RRR-222, parity gap G-35; Section 11.7 and 11.11): Shift time across a selection. The Owner selects a record
 * in the records table, shifts it +15 minutes, reads a preview that names the successor pushed outside the selection,
 * applies, sees the new times, and undoes with Cmd or Ctrl+Z through app.bulk_update_records.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("shift a selection by minutes, pushing a successor, and undo it", async ({ page }) => {
  const slug = await newOwnerOrg(page, "p8shift", "Sam Shifter");
  await createProject(page, slug, "PST", "Press Day");
  const first = await createTask(page, slug, "Open the doors", "2027-03-12T10:00");
  const second = await createTask(page, slug, "Seat the press", "2027-03-12T10:00");
  await addDependency(page, slug, second, first, "Open the doors");

  await page.goto(`/${slug}/work/all-records?view=table`);
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();
  await settle(page);
  await grid.getByRole("row").filter({ hasText: first }).getByRole("checkbox").click();
  await page
    .getByRole("toolbar", { name: "Bulk actions" })
    .getByRole("button", { name: "Shift time" })
    .click();
  const dialog = page.getByRole("dialog", { name: /Shift time of 1 record/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "+15 min" }).click();
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByText("1 selected record moves by +15 min.")).toBeVisible();
  await expect(dialog.getByText("1 successor outside the selection is pushed:")).toBeVisible();
  await expect(dialog).toContainText(`${second} Seat the press`);
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Move 2 records" }).click();
  await expect(page.getByText("Moved 2 records +15 min.").first()).toBeVisible();

  // Cmd or Ctrl+Z sends every moved record's old dates back, expecting the new ones.
  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByText(/Undone: Moved 2 records/)).toBeVisible();
  expect(await dueOf(page, slug, first)).toBe("2027-03-12T10:00");
  expect(await dueOf(page, slug, second)).toBe("2027-03-12T10:00");
});

test("a minute retime of one record previews and applies", async ({ page }) => {
  const slug = await newOwnerOrg(page, "p8retime", "Rae Retime");
  await createProject(page, slug, "PRT", "Rehearsal Day");
  const key = await createTask(page, slug, "Run the cue-to-cue", "2027-03-13T14:00");
  await page.goto(`/${slug}/r/${key}`);
  const retime = page.getByRole("region", { name: "Retime by minutes" });
  await retime.getByLabel("Move by").fill("+1:30");
  await retime.getByRole("button", { name: "Preview" }).click();
  await expect(retime.getByText("Only this record moves.")).toBeVisible();
  await retime.getByRole("button", { name: "Apply" }).click();
  await expect(retime.getByRole("button", { name: "Preview" })).toBeVisible();
  expect(await dueOf(page, slug, key)).toBe("2027-03-13T15:30");
});
