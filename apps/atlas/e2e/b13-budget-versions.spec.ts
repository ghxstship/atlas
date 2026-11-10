import { expect as baseExpect, settle, test } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { localSql, newBudget, newLine, removeBudget } from "./b13-support";
import { uniqueId } from "./support";

/**
 * B13 (RRR-237, G-210): Take snapshot freezes a budget's plan, Compare lists what changed against the live budget with a
 * NULL-aware total, and a Snapshot goes to Trash with Undo.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 25_000 });

test("a snapshot compares with the live budget", async ({ page }) => {
  const id = uniqueId();
  const budgetId = await newBudget(`Versions budget ${id}`);
  const line = await newLine(budgetId, 1, "Stage deck", 10000);
  try {
    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(`/${DEMO_ORG}/finance/budgets?budget=${budgetId}`);
    await settle(page);
    await expect(async () => {
      await page.getByRole("button", { name: "Versions", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Budget versions" })).toBeVisible({
        timeout: 5_000,
      });
    }).toPass();
    const drawer = page.getByRole("dialog", { name: "Budget versions" });
    await drawer.getByLabel("Snapshot name").fill(`Before changes ${id}`);
    await drawer.getByRole("button", { name: "Take snapshot", exact: true }).click();
    await expect(drawer.getByText(`Before changes ${id}`)).toBeVisible();

    await localSql(`update app.budget_lines set quantity = 3 where id = $1`, [line]);
    await drawer.getByRole("button", { name: "Compare", exact: true }).click();
    await page.waitForURL(/compare=/);
    await expect(
      page.getByRole("heading", { name: `Before changes ${id} to Live budget` }),
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: "Changed", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "$100.00", exact: true }).first()).toBeVisible();

    await page.goto(`/${DEMO_ORG}/finance/budgets?budget=${budgetId}`);
    await settle(page);
    await expect(async () => {
      await page.getByRole("button", { name: "Versions", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Budget versions" })).toBeVisible({
        timeout: 5_000,
      });
    }).toPass();
    await page
      .getByRole("dialog", { name: "Budget versions" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect(
      page.getByRole("dialog", { name: "Budget versions" }).getByText(`Before changes ${id}`),
    ).toBeVisible();
  } finally {
    await removeBudget(budgetId);
  }
});
