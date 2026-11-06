import { expect as baseExpect, test } from "./engine-test";
import { expectAccessible } from "./support";
import { createProject, createTask, newOwnerOrg } from "./b4-support";
import { expectCalmScreen } from "./b14-support";

/**
 * B14 copy from the last event (RRR-238; G-252): last year's project holds a dated task; this year's project, four
 * weeks later, copies its plan from Settings. The preview lists the task with its new date and writes nothing; Copy
 * writes it and a toast names the count, and the task is on this year's project four weeks later on the wall clock. A new
 * project started from a past one waits on the Copy step until the project is named, so Review never promises a copy
 * that would not happen.
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

test("a new project from a past one names that project before it can go on", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const slug = await newOwnerOrg(page, "b14w", "Wren Wizard");
  await createProject(page, slug, {
    key: "LYW",
    name: "Last Year Wizard",
    from: "2027-03-01",
    to: "2027-03-03",
  });
  await createTask(page, slug, "Hang the banners", "2027-03-02T18:00");

  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByRole("button", { name: "Start from a template or a past project" }).click();
  await dialog.getByLabel("A past project").check();
  const next = dialog.getByRole("button", { name: "Next" });
  await next.click();
  await dialog.getByLabel("Project key", { exact: true }).fill("TYW");
  await dialog.getByLabel("Project name", { exact: true }).fill("This Year Wizard");
  await dialog.getByLabel("First production day", { exact: true }).fill("2027-03-29");
  await dialog.getByLabel("Last production day", { exact: true }).fill("2027-03-31");
  await next.click();
  await expect(dialog.getByRole("heading", { name: "Load-in and load-out" })).toBeFocused();
  // With no project fields there is no Details step: the next one is Copy.
  await next.click();
  await expect(dialog.getByRole("heading", { name: "Copy", exact: true })).toBeFocused();
  await expectCalmScreen(page);

  // No project named: the step holds, says why and moves to the field.
  await next.click();
  await expect(dialog.getByText("Choose the past project to copy from.")).toBeVisible();
  await expect(dialog.getByLabel("Copy from", { exact: true })).toBeFocused();
  await expect(dialog.getByRole("heading", { name: "Copy", exact: true })).toBeVisible();

  await dialog.getByLabel("Copy from", { exact: true }).selectOption({
    label: "LYW Last Year Wizard",
  });
  await expect(dialog.getByText("Choose the past project to copy from.")).toHaveCount(0);
  await expect(dialog.getByLabel("Move dates by (days)")).toHaveValue("28");
  await next.click();
  await expect(dialog.getByRole("heading", { name: "Review" })).toBeFocused();
  await expect(dialog.getByText("None; setup is copied from the past project")).toBeVisible();
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/TYW/overview`);
  await page.goto(`/${slug}/p/TYW/work`);
  await expect(page.getByText("Hang the banners")).toBeVisible();
});
