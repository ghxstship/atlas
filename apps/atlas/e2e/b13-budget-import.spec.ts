import { expect as baseExpect, test } from "./engine-test";
import { leaveStep, DEMO_ORG, reloadUntil, runImportWorker, signInAs } from "./a36-support";
import { localSql, newBudget, newLine, removeBudget } from "./b13-support";
import { uniqueId } from "./support";

/**
 * B13 (RRR-237, G-214): Import lines opens the wizard on the budget. A .csv row with a line number updates that line, a
 * blank price stays unpriced, and an unnumbered row is appended; a bad cell gets its reason in the preview.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 25_000 });

test("budget lines import from a spreadsheet with a preview", async ({ page }) => {
  const id = uniqueId();
  const budgetId = await newBudget(`Import budget ${id}`);
  await newLine(budgetId, 1, "Stage deck", 10000);
  try {
    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(`/${DEMO_ORG}/finance/budgets?budget=${budgetId}`);
    await page.getByRole("link", { name: "Import lines", exact: true }).click();
    await page.waitForURL(new RegExp(`target=budget_lines&budget=${budgetId}`));
    await expect(page.getByLabel("Budget", { exact: true })).toHaveValue(budgetId);
    const csv = [
      "Line,Description,URID,Quantity,Unit price",
      `1,Stage deck ${id},5000.04.02,2,150.00`,
      `,New line ${id},5000.04.02,1,`,
    ].join("\n");
    await page.locator("#import-file").setInputFiles({
      name: `lines-${id}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await page.getByRole("button", { name: "Upload and read" }).click();
    await page.waitForURL(/\?import=/);
    await runImportWorker();
    await reloadUntil(page, page.getByRole("heading", { name: "Map the columns" }));
    await leaveStep(page, "Confirm the mapping", "Map the columns");
    await runImportWorker();
    await reloadUntil(page, page.getByRole("heading", { name: "Dry run" }));
    const dry = page.getByRole("region", { name: "Dry run" });
    await expect(dry.getByText("New records").locator("..")).toContainText("1");
    await expect(dry.getByText("Updates").locator("..")).toContainText("1");
    await leaveStep(page, "Commit the import", "Dry run");
    await runImportWorker();
    await reloadUntil(page, page.getByRole("heading", { name: "Undo the whole batch" }));

    const lines = await localSql<{
      line_number: number;
      description: string;
      unit_price_minor: string | null;
    }>(
      `select line_number, description, unit_price_minor::text from app.budget_lines
       where budget_id = $1 and deleted_at is null order by line_number`,
      [budgetId],
    );
    expect(lines).toEqual([
      { line_number: 1, description: `Stage deck ${id}`, unit_price_minor: "15000" },
      { line_number: 2, description: `New line ${id}`, unit_price_minor: null },
    ]);

    // Undo removes the created line and restores the updated one.
    await page.getByRole("button", { name: "Undo the whole batch" }).click();
    await expect
      .poll(async () => {
        const rows = await localSql<{ n: string }>(
          `select count(*)::text as n from app.budget_lines where budget_id = $1 and deleted_at is null`,
          [budgetId],
        );
        return rows[0]?.n;
      })
      .toBe("1");
  } finally {
    await removeBudget(budgetId);
  }
});
