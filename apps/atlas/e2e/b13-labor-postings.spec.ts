import { expect as baseExpect, test } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import {
  DEMO_ORG_ID,
  DEMO_PROJECT,
  localSql,
  newBudget,
  newLine,
  removeBudget,
} from "./b13-support";
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
  // A role and a rate of the demo Field lead, on a week long after anything the seed writes.
  const [member] = await localSql<{ id: string }>(
    `select m.id from app.memberships m join auth.users u on u.id = (select p.user_id from app.people p where p.id = m.person_id)
     where m.org_id = $1 and u.email = 'field@example.com'`,
    [DEMO_ORG_ID],
  );
  const membership = member?.id as string;
  const year = 2040 + Math.floor(Math.random() * 40);
  const monday = `${year}-06-04`;
  try {
    await localSql(
      `insert into app.pay_rates (org_id, membership_id, role_code, rate_minor, currency_code, effective_from)
       values ($1, $2, '5000.51.02', 3000, 'USD', '2040-01-01')`,
      [DEMO_ORG_ID, membership],
    ).catch(() => undefined);
    const [shift] = await localSql<{ id: string }>(
      `insert into app.shifts (org_id, project_id, membership_id, role_code, starts_at, ends_at, time_zone, budget_line_id)
       values ($1, $2, $3, '5000.51.02', $4::timestamptz, $4::timestamptz + interval '2 hours', 'America/New_York', $5) returning id`,
      [DEMO_ORG_ID, DEMO_PROJECT, membership, `${monday} 14:00+00`, line],
    );
    await localSql(
      `insert into app.time_entries (org_id, project_id, membership_id, shift_id, clock_in, clock_out)
       values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '2 hours')`,
      [DEMO_ORG_ID, DEMO_PROJECT, membership, shift?.id, `${monday} 14:00+00`],
    );
    const [sheet] = await localSql<{ id: string }>(
      `insert into app.timesheets (org_id, project_id, membership_id, period_start, period_end, timesheet_state)
       values ($1, $2, $3, $4::date - 3, $4::date + 3, 'Submitted') returning id`,
      [DEMO_ORG_ID, DEMO_PROJECT, membership, monday],
    );
    const [owner] = await localSql<{ id: string }>(
      `select id from app.people where user_id = (select id from auth.users where email = 'owner@example.com')`,
    );
    await localSql(
      `insert into app.timesheet_approvals (org_id, timesheet_id, approved_by, approved_minutes) values ($1, $2, $3, 120)`,
      [DEMO_ORG_ID, sheet?.id, owner?.id],
    );

    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(`/${DEMO_ORG}/finance/budgets?budget=${budgetId}`);
    await expect(
      page.getByRole("grid").getByRole("gridcell", { name: "$60.00", exact: true }).first(),
    ).toBeVisible();

    await page.goto(`/${DEMO_ORG}/reports/labor?project=NWS`);
    await expect(
      page.getByRole("heading", { name: "Posted to budget by team", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: "Own team", exact: true }).first()).toBeVisible();
  } finally {
    await removeBudget(budgetId);
  }
});
