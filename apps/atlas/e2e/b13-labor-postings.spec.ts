import { expect as baseExpect, settle, test } from "./engine-test";
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
      `insert into app.timesheets (org_id, project_id, membership_id, period_start, period_end)
       values ($1, $2, $3, $4::date - 3, $4::date + 3) returning id`,
      [DEMO_ORG_ID, DEMO_PROJECT, membership, monday],
    );
    // Submitted as its worker, through the lifecycle, since a timesheet starts Proposed.
    const [worker] = await localSql<{ user_id: string }>(
      `select pe.user_id from app.memberships m join app.people pe on pe.id = m.person_id where m.id = $1`,
      [membership],
    );
    await localSql(
      `begin;
       select set_config('request.jwt.claims', '{"sub":"${worker?.user_id}","role":"authenticated"}', true);
       set local role authenticated;
       select app.submit_timesheet('${sheet?.id}');
       commit;`,
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

    // Transactions explains the figure: Labor equals the line's Actual.
    const transactions = page.getByRole("button", { name: "Transactions", exact: true });
    await settle(page);
    await expect(async () => {
      await page
        .getByRole("grid")
        .getByRole("gridcell", { name: "Stagehands", exact: true })
        .click();
      await expect(transactions).toBeEnabled({ timeout: 3_000 });
    }).toPass();
    await transactions.click();
    const drawer = page.getByRole("dialog", { name: "Transactions on this line" });
    await expect(drawer.getByRole("heading", { name: /^Labor/ })).toContainText("$60.00");

    await page.goto(`/${DEMO_ORG}/reports/labor?project=NWS`);
    await expect(
      page.getByRole("heading", { name: "Posted to budget by team", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: "Own team", exact: true }).first()).toBeVisible();
  } finally {
    await removeBudget(budgetId);
  }
});

test("a member's shift takes its Budget line from the form and the bulk bar", async ({ page }) => {
  const id = uniqueId();
  const budgetId = await newBudget(`Shift lines ${id}`);
  const first = await newLine(budgetId, 1, "Riggers", 2000, "Labor");
  const second = await newLine(budgetId, 2, "Carpenters", 2000, "Labor");
  const [member] = await localSql<{ id: string }>(
    `select m.id from app.memberships m join auth.users u on u.id = (select p.user_id from app.people p where p.id = m.person_id)
     where m.org_id = $1 and u.email = 'field@example.com'`,
    [DEMO_ORG_ID],
  );
  // A week far past anything the seed plans, so the list holds this one shift of the person.
  const date = `${2040 + Math.floor(Math.random() * 40)}-06-06`;
  const list = `/${DEMO_ORG}/crew/shifts?project=NWS&view=table&week=${date}`;
  const linked = (line: string) =>
    localSql<{ id: string }>(
      `select id from app.shifts where budget_line_id = $1 and deleted_at is null and membership_id = $2`,
      [line, member?.id],
    );
  try {
    await signInAs(page, "owner@example.com", DEMO_ORG);

    // Created with a line: createShift writes it.
    await page.goto(`${list}&create=1`);
    const create = page.getByRole("dialog", { name: "New shift" });
    await expect(create).toBeVisible();
    await settle(page);
    await create.getByLabel("Person", { exact: true }).selectOption(member?.id as string);
    await create.getByLabel(/^Starts/).fill(`${date}T09:00`);
    await create.getByLabel(/^Ends/).fill(`${date}T11:00`);
    await create.getByLabel("Budget line", { exact: true }).selectOption(first);
    await create.getByRole("button", { name: "New shift" }).click();
    await expect(create).toBeHidden();
    const [shift] = await linked(first);
    expect(shift?.id).toBeTruthy();

    // Edited to another line: updateShift writes it, and the form opens on the line the shift holds.
    await page.goto(`${list}&edit=${shift?.id}`);
    const edit = page.getByRole("dialog", { name: "Edit shift" });
    await expect(edit.getByLabel("Budget line", { exact: true })).toHaveValue(first);
    await settle(page);
    await edit.getByLabel("Budget line", { exact: true }).selectOption(second);
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await expect(edit).toBeHidden();
    await expect.poll(async () => (await linked(second)).map((r) => r.id)).toEqual([shift?.id]);

    // Editing something else keeps the line.
    await page.goto(`${list}&edit=${shift?.id}`);
    await expect(edit.getByLabel("Budget line", { exact: true })).toHaveValue(second);
    await settle(page);
    await edit.getByLabel(/^Ends/).fill(`${date}T12:00`);
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await expect(edit).toBeHidden();
    await expect.poll(async () => (await linked(second)).map((r) => r.id)).toEqual([shift?.id]);

    // The bulk bar of one project's shifts moves it back.
    await page.goto(list);
    await settle(page);
    const row = page.getByRole("grid").getByRole("row").nth(1);
    await expect(async () => {
      await row.getByRole("checkbox").click();
      await expect(page.getByRole("status").filter({ hasText: "1 selected" })).toBeAttached({
        timeout: 3_000,
      });
    }).toPass();
    await page
      .getByRole("toolbar", { name: "Bulk actions" })
      .getByRole("button", { name: "Change Budget line" })
      .click();
    const bulk = page.getByRole("dialog", { name: /Change Budget line on 1 row/ });
    // The bulk dialog's values are encoded, so its choice is by label.
    await bulk
      .getByLabel("New Budget line")
      .selectOption({ label: `NWS · Shift lines ${id} · 1 Riggers` });
    await bulk.getByRole("button", { name: "Preview" }).click();
    await bulk.getByRole("button", { name: /^Apply to 1 row/ }).click();
    await expect(page.getByText(/^Changed 1 row/).first()).toBeVisible();
    await expect.poll(async () => (await linked(first)).map((r) => r.id)).toEqual([shift?.id]);
  } finally {
    await removeBudget(budgetId);
  }
});
