import { expect, test } from "@playwright/test";
import { expectAccessibleInBothThemes } from "./a16-support";
import { DEMO_ORG, reloadUntil, runImportWorker, signInAs } from "./a36-support";
import { uniqueId } from "./support";

/**
 * Journey 27 (Section 20.2, Section 4.6.2): import a customer spreadsheet through the wizard, map its
 * columns, review the fuzzy duplicate of an existing company, read the dry run, commit in one batch,
 * then undo the whole batch. The import worker runs with the service role (runImportWorker).
 */
test("journey 27: import customers, review a fuzzy duplicate, commit and undo the batch", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const id = uniqueId();
  const csv = [
    "Company,Vendor type,Notes",
    `Bayfront Catering ${id},,New client`,
    "Bayline Audio Rental,,Same company as Bayline Audio Rentals",
    ",Sponsor,No name",
    `Pier Nine Events ${id},Wizards,Unknown type`,
  ].join("\n");

  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/import`);
  await expect(page.getByRole("heading", { level: 1, name: "Import" })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // Upload: customers go to the counterparties target.
  await page.getByLabel("Import into").selectOption("counterparties");
  await page
    .locator("#import-file")
    .setInputFiles({ name: `customers-${id}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Upload and read" }).click();
  await page.waitForURL(/\?import=/);
  // The spreadsheet is checked for viruses before it is read (ADR 0034).
  await expect(page.getByText("Checking the file for viruses")).toBeVisible();

  // Detect, then map: the wizard suggests Name and Vendor type and skips Notes.
  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Map the columns" }));
  await expect(page.getByLabel("Column Company")).toHaveValue("name");
  await expect(page.getByLabel("Column Vendor type")).toHaveValue("counterparty_type");
  await expect(page.getByLabel("Column Notes")).toHaveValue("");
  await expectAccessibleInBothThemes(page);
  await page.getByRole("button", { name: "Confirm the mapping" }).click();
  await expect(page.getByText("Checking every row")).toBeVisible();

  // Validate: one row lacks a name, one names an unknown canon type, one is a near-duplicate.
  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Dry run" }));
  await expect(page.getByText("Row 3 looks like Bayline Audio Rentals")).toBeVisible();
  await expect(page.getByText("Company: required")).toBeVisible();
  await expect(page.getByText("Vendor type: not a vendor type in the canon")).toBeVisible();
  await expect(page.getByText("Decide 1 possible duplicate before committing.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Commit the import" })).toBeDisabled();
  await expectAccessibleInBothThemes(page);

  // Review: merge the duplicate; the dry run now counts one create, one merge and two refusals.
  await page.getByRole("button", { name: "Merge into it" }).click();
  await expect(page.getByText("Merged into the existing record.")).toBeVisible();
  await expect(page.getByText("Valid rows are written in one batch.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Dry run" })).toContainText("Merges");

  // Commit in one batch.
  await page.getByRole("button", { name: "Commit the import" }).click();
  await expect(page.getByText("Writing the rows")).toBeVisible();
  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Undo the whole batch" }));
  await expect(page.getByText("2 rows were written")).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // Undo the whole batch with a reason: both written rows revert.
  await page.getByLabel("Why undo it").fill("Imported the wrong customer list.");
  await page.getByRole("button", { name: "Undo the batch" }).click();
  await expect(page.getByRole("heading", { name: "Batch undone" })).toBeVisible();
  await expect(page.getByText("2 rows reverted, none kept.")).toBeVisible();
});

test("journey 27: a refused upload keeps the chosen file and says why", async ({ page }) => {
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/import`);
  await page
    .locator("#import-file")
    .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.getByRole("button", { name: "Upload and read" }).click();
  await expect(page.getByText("Upload a .csv or .xlsx spreadsheet.")).toBeVisible();
  await expect(page).not.toHaveURL(/\?import=/);
});
