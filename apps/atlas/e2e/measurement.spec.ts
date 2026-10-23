import { expect as baseExpect, test, type Page } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

// Each save re-renders the Gates tab with its gate and measurement reads before the form reports back, which takes
// longer than the default five seconds on a loaded machine.
const expect = baseExpect.configure({ timeout: 30_000 });

/**
 * A98 (RRR-143, finding A65-030, Section 4.10): objectives are set at gate 1 and recorded on the evidence spine;
 * gate 8 records figures, one of them not measured, corrects one with a reason, adds earned media coverage and
 * records the measurement; the report shows objectives against figures with Unmeasured where nothing was measured,
 * never zero, for the project and rolled up for the org. Each run signs up a new owner in a new org.
 */

test.use({ reducedMotion: "reduce" });

async function newProject(page: Page): Promise<{ slug: string; key: string }> {
  const id = uniqueId();
  const slug = `msr-${id}`;
  const key = "MSR";
  await signUp(page, { name: "Pat Producer", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Measurement ${id}`, slug });
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill(key);
  await dialog.getByLabel("Project name").fill("Miami Summer Run");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/${key}/overview`);
  return { slug, key };
}

async function setObjective(
  page: Page,
  metric: string,
  direction: string,
  target: string,
  unit: string,
) {
  await page
    .locator('section[aria-labelledby="gate-1"]')
    .getByRole("button", { name: "Set objective" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Set an objective" });
  await dialog.getByLabel("Measure", { exact: true }).selectOption({ label: metric });
  await dialog.getByLabel("Direction").selectOption({ label: direction });
  await dialog.getByLabel("Target").fill(target);
  await dialog.getByLabel("Unit").selectOption({ label: unit });
  await dialog.getByRole("button", { name: "Save objective" }).click();
  await expect(dialog).toBeHidden();
}

async function recordFigure(page: Page, metric: string, value: string | null, unit?: string) {
  await page
    .locator('section[aria-labelledby="gate-8"]')
    .getByRole("button", { name: "Record figure" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Record a figure" });
  await dialog.getByLabel("Measure", { exact: true }).selectOption({ label: metric });
  if (value === null) {
    await dialog.getByLabel("Not measured").check();
  } else {
    await dialog.getByLabel("Figure", { exact: true }).fill(value);
    if (unit) await dialog.getByLabel("Unit").selectOption({ label: unit });
  }
  await dialog.getByRole("button", { name: "Record figure" }).click();
  await expect(dialog).toBeHidden();
}

/** The summary row of a figure in the gate 8 panel or the report. */
function summaryRow(page: Page, metric: string) {
  return page
    .getByRole("region", { name: /^Objectives against measured figures/ })
    .getByRole("row")
    .filter({ hasText: metric });
}

test("objectives at gate 1, figures and earned media at gate 8, Unmeasured never zero", async ({
  page,
  context,
}) => {
  const { slug, key } = await newProject(page);
  await page.goto(`/${slug}/p/${key}/gates`);

  // Gate 1: objectives, then recorded on the evidence spine.
  const gate1 = page.locator('section[aria-labelledby="gate-1"]');
  await expect(gate1.getByRole("heading", { name: "Objectives" })).toBeVisible();
  await expect(gate1).toContainText("No objectives yet.");
  await setObjective(page, "Attendance", "At Least", "5000", "Count");
  await setObjective(page, "Waste Generated", "At Most", "2", "Metric tons (t)");
  await setObjective(page, "Water Used", "At Most", "50", "Cubic meters (m³)");
  const objectives = gate1.getByRole("region", { name: "Objectives of this project" });
  await expect(objectives).toContainText("At Most 2 t");
  await expect(objectives).toContainText("At Least 5,000");
  await expectAccessible(page);
  await gate1.getByRole("button", { name: "Record objectives as gate 1 evidence" }).click();
  await expect(
    gate1.getByText("The objectives are evidence for gate 1 criterion G1.OBJECTIVES_STATED."),
  ).toBeVisible();
  await expect(gate1).toContainText(`urn:xpms:project-objectives:`);

  // Gate 8: figures, one not measured.
  const gate8 = page.locator('section[aria-labelledby="gate-8"]');
  await expect(gate8.getByRole("heading", { name: "Measurement" })).toBeVisible();
  await expect(summaryRow(page, "Water Used")).toContainText("Unmeasured");
  // The dialog loads its form on first open, passes axe and closes with Escape.
  await gate8.getByRole("button", { name: "Record figure" }).click();
  const figureDialog = page.getByRole("dialog", { name: "Record a figure" });
  await expect(figureDialog.getByLabel("Measure", { exact: true })).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await expect(figureDialog).toBeHidden();
  await recordFigure(page, "Waste Generated", "1500", "Kilograms (kg)");
  await recordFigure(page, "Water Used", null);
  // The person's units are imperial by default: 1,500 kg shows as 3,306.93 lb against 4,409.25 lb (2 t).
  await expect(summaryRow(page, "Waste Generated")).toContainText("3,306.93 lb");
  await expect(summaryRow(page, "Waste Generated")).toContainText("At Most 4,409.25 lb");
  await expect(summaryRow(page, "Waste Generated")).toContainText("Set as 2 t");
  await expect(summaryRow(page, "Waste Generated")).toContainText("Met");
  // Water was recorded as not measured: it stays Unmeasured, never 0.
  await expect(summaryRow(page, "Water Used")).toContainText("Unmeasured");
  await expect(summaryRow(page, "Water Used")).toContainText("1 entry unmeasured");
  await expect(summaryRow(page, "Water Used")).not.toContainText(/\b0 gal\b/);
  await expect(summaryRow(page, "Attendance")).toContainText("Unmeasured");

  // A correction needs a reason and lands in the correction log.
  await gate8.getByRole("button", { name: /^Correct Waste Generated for / }).click();
  const correct = page.getByRole("dialog", { name: /^Correct Waste Generated for / });
  await correct.locator('input[name="value"]').fill("2.5");
  await correct.getByLabel("Unit").selectOption({ label: "Metric tons (t)" });
  await correct.getByRole("button", { name: "Save correction" }).click();
  await expect(correct.getByRole("alert")).toContainText("Check the highlighted fields.");
  await correct.getByLabel("Reason").fill("Weighbridge ticket replaces the estimate.");
  await correct.getByRole("button", { name: "Save correction" }).click();
  await expect(correct).toBeHidden();
  await expect(gate8).toContainText("Corrected by Pat Producer");
  await expect(gate8).toContainText("Reason: Weighbridge ticket replaces the estimate.");
  await expect(summaryRow(page, "Waste Generated")).toContainText("Not Met");

  // Earned media coverage: the count and reach come from the pieces.
  await gate8.getByRole("button", { name: "Add coverage" }).click();
  const coverage = page.getByRole("dialog", { name: "Add coverage" });
  await coverage.getByLabel("Headline").fill("Summer Run opens on the bay");
  await coverage.getByLabel("Outlet").fill("Miami Herald");
  await coverage.getByLabel("Link").fill(`https://news.example.test/summer-run-${uniqueId()}`);
  await coverage.getByLabel("Reach").fill("120000");
  await coverage.getByLabel("Tone").selectOption({ label: "Positive" });
  await coverage.getByRole("button", { name: "Add coverage" }).click();
  await expect(coverage).toBeHidden();
  await expect(gate8.getByRole("link", { name: "Summer Run opens on the bay" })).toBeVisible();
  await expect(summaryRow(page, "Earned Media Reach")).toContainText("120,000");
  await expect(summaryRow(page, "Coverage Pieces")).toContainText("1");
  await expect(gate8).toContainText("Tone: 1 positive, 0 neutral, 0 negative, 0 unrated.");
  await expectAccessible(page);
  await gate8.getByRole("button", { name: "Record measurement as gate 8 evidence" }).click();
  await expect(
    gate8.getByText("The measurement is evidence for gate 8 criterion G8.MEASUREMENT_REPORTED."),
  ).toBeVisible();

  // The report for the project, in the table and chart views, and the org rollup.
  await page.goto(`/${slug}/reports/measurement?project=${key}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Objectives and Measurement" }),
  ).toBeVisible();
  await expect(summaryRow(page, "Water Used")).toContainText("Unmeasured");
  await expect(summaryRow(page, "Energy Used")).toContainText("Unmeasured");
  await expect(summaryRow(page, "Waste Generated")).toContainText("Not Met");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeVisible();
  await expectAccessible(page);
  await page.goto(`/${slug}/reports/measurement?project=${key}&view=chart`);
  await expect(page.getByRole("group", { name: /^Objectives by outcome/ })).toBeVisible();
  await expect(page.getByRole("img", { name: "Objectives, Not Met: 1" })).toBeVisible();
  await expect(summaryRow(page, "Water Used")).toContainText("Unmeasured");
  await expectAccessible(page);
  await page.goto(`/${slug}/reports/measurement`);
  const byProject = page.getByRole("region", { name: "Objectives by project" });
  await expect(byProject.getByRole("link", { name: /MSR · Miami Summer Run/ })).toBeVisible();
  const acrossProjects = page.getByRole("region", { name: "Figures across projects" });
  await expect(acrossProjects.getByRole("row").filter({ hasText: "Water Used" })).toContainText(
    "Unmeasured",
  );
  await expectAccessible(page);

  // The other theme: the gate panels and both report views pass axe in light as well.
  await context.addCookies([
    { name: "xos-theme", value: "light", domain: new URL(page.url()).hostname, path: "/" },
  ]);
  for (const path of [
    `/${slug}/p/${key}/gates`,
    `/${slug}/reports/measurement?project=${key}`,
    `/${slug}/reports/measurement?view=chart`,
  ]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expectAccessible(page);
  }
});
