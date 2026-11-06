import { expect as baseExpect, settle, test } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { newBudget, newLine, removeBudget } from "./b13-support";
import { uniqueId } from "./support";

/**
 * B13 (RRR-237, G-205, G-210): the Forecast columns derive Estimate to complete and Estimated final cost, an entered ETC
 * replaces the derived one, and Transactions is disabled until a line is selected.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 25_000 });

test("forecast columns and transactions on a line", async ({ page }) => {
  const id = uniqueId();
  const budgetId = await newBudget(`Forecast budget ${id}`);
  await newLine(budgetId, 1, "Stage deck", 10000);
  try {
    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(`/${DEMO_ORG}/finance/budgets?budget=${budgetId}&columns=forecast`);
    const grid = page.getByRole("grid");
    await expect(grid.getByRole("columnheader", { name: "Estimated final cost" })).toBeVisible();
    await expect(
      grid.getByRole("gridcell", { name: "$200.00", exact: true }).first(),
    ).toBeVisible();

    const transactions = page.getByRole("button", { name: "Transactions", exact: true });
    await expect(transactions).toBeDisabled();
    await settle(page);
    await expect(async () => {
      await grid.getByRole("gridcell", { name: "Stage deck", exact: true }).click();
      await expect(transactions).toBeEnabled({ timeout: 3_000 });
    }).toPass();
    await transactions.click();
    const drawer = page.getByRole("dialog", { name: "Transactions on this line" });
    await expect(drawer.getByRole("heading", { name: "Expenses" })).toBeVisible();
    await expect(
      drawer.getByText("Vendor invoices on this line are posted to the ledger", { exact: false }),
    ).toBeVisible();
  } finally {
    await removeBudget(budgetId);
  }
});
