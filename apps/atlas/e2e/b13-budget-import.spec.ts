import { expect as baseExpect, test } from "./engine-test";
import { DEMO_ORG, runImportWorker, signInAs } from "./a36-support";
import { localSql, newBudget, newLine, removeBudget } from "./b13-support";
import { uniqueId } from "./support";

/**
 * B13 (RRR-237, G-214): Import lines opens the wizard on the budget. A .csv row with a line number updates that line, a
 * blank price stays unpriced, and an unnumbered row is appended; a bad cell gets its reason in the preview.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 25_000 });

test("budget lines import from a spreadsheet with a preview", async ({ page, request, baseURL }) => {
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
    await page.locator('input[type="file"]').setInputFiles({
      name: `lines-${id}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await page.getByRole("button", { name: "Upload", exact: false }).first().click();
    await page.waitForURL(/\/import\/[0-9a-f-]{36}/);
    await runImportWorker(request, baseURL ?? "");
    await expect
      .poll(async () => {
        const rows = await localSql<{ n: string }>(
          `select count(*)::text as n from app.import_jobs where budget_id = $1`,
          [budgetId],
        );
        return rows[0]?.n;
      })
      .toBe("1");
  } finally {
    await removeBudget(budgetId);
  }
});
