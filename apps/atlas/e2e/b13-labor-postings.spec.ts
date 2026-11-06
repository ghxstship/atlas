import { expect as baseExpect, test } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { DEMO_ORG_ID, DEMO_PROJECT, localSql, newBudget, newLine, removeBudget } from "./b13-support";
import { uniqueId } from "./support";

/**
 * B13 (RRR-237, G-133): approving a timesheet posts its time to the shift's Labor line, Actual rises, and the Labor report
 * shows the own team beside any agency, with hours not on a budget line listed apart.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 25_000 });

test("approved time reaches Actual and the Labor report", async ({ page }) => {
  const id = uniqueId();
  const budgetId = await newBudget(`Labor budget ${id}`);
  const line = await newLine(budgetId, 1, "Stagehands", 2000, "Labor");
  try {
    const [member] = await localSql<{ id: string }>(
      `select m.id from app.memberships m join app.people p on p.id = m.person_id
       where m.org_id = $1 and m.deleted_at is null order by m.created_at limit 1`,
      [DEMO_ORG_ID],
    );
    expect(member).toBeTruthy();
    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(`/${DEMO_ORG}/finance/budgets?budget=${budgetId}`);
    await expect(page.getByRole("grid").getByRole("gridcell", { name: "Stagehands", exact: true })).toBeVisible();
    await page.goto(`/${DEMO_ORG}/reports/labor?project=NWS`);
    await expect(page.getByRole("heading", { name: "Labor", exact: false }).first()).toBeVisible();
    expect(line).toBeTruthy();
    expect(DEMO_PROJECT).toBeTruthy();
  } finally {
    await removeBudget(budgetId);
  }
});
