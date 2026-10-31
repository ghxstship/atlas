import { expect as baseExpect, test } from "./engine-test";
import { expectAccessible } from "./support";
import { createProject, createTask, newOwnerOrg } from "./b4-support";

/**
 * B14 copy from the last event (RRR-238; G-252): last year's project holds a dated task; this year's project, four
 * weeks later, copies its plan from Settings. The preview lists the task with its new date and writes nothing; Copy
 * writes it and a toast names the count, and the task is on this year's project four weeks later on the wall clock.
 */

test.use({ reducedMotion: "reduce" });
const expect = baseExpect.configure({ timeout: 20_000 });

test("a past project's plan is previewed and copied four weeks later", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const slug = await newOwnerOrg(page, "b14c", "Casey Copy");
  await createProject(page, slug, {
    key: "LYE",
    name: "Last Year Edition",
    from: "2027-03-01",
    to: "2027-03-03",
  });
  await createTask(page, slug, "Rig the follow spots", "2027-03-02T18:00");
  await createProject(page, slug, {
    key: "TYE",
    name: "This Year Edition",
    from: "2027-03-29",
    to: "2027-03-31",
  });

  await page.goto(`/${slug}/p/TYE/settings`);
  await page.getByRole("button", { name: "Copy from a project" }).click();
  const dialog = page.getByRole("dialog", { name: "Copy from another project" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Copy from").selectOption({ label: "LYE Last Year Edition" });
  await expect(dialog.getByLabel("Move dates by (days)")).toHaveValue("28");
  for (const part of ["Pass categories", "Hotel blocks", "Budgets", "Advance forms"]) {
    await dialog.getByLabel(part).uncheck();
  }
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByText(/Plan: \d+ to copy, \d+ skipped/)).toBeVisible();
  await expect(dialog.getByText("Rig the follow spots")).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByText(/Copied \d+ items; \d+ skipped\./)).toBeVisible();

  await page.goto(`/${slug}/p/TYE/work`);
  await expect(page.getByText("Rig the follow spots")).toBeVisible();
});
