import { expect as baseExpect, test, type Locator, type Page } from "./engine-test";
import {
  ROLE_ACCOUNTS,
  ROLE_PEOPLE,
  roleEngagement,
  sentDocument,
  suffix,
  transition,
  PEOPLE,
} from "./role-fixtures";
import { expectAccessible, signIn, sql } from "./support";

/**
 * A122 power editing in Gateway (RRR-166, ADR 0082), as a staff member of the demo agency on a new
 * Active engagement:
 *   - two documents the org sent are selected and signed in one bulk action after a preview;
 *   - a timesheet row's menu opens by right-click and by Shift+F10 with the row's actions;
 *   - two drafted timesheets are submitted in bulk, Cmd or Ctrl+Z recalls them through the server
 *     and Shift+Cmd or Ctrl+Z submits them again;
 *   - the documents list shows a document the org sends while the page is open, and the
 *     engagements list follows the engagement's state, without a reload.
 * Each run makes its own engagement, documents and timesheets, so reruns never collide.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 30_000 });

/** The grid row whose cells hold `text`. */
function row(grid: Locator, text: string): Locator {
  return grid.getByRole("row").filter({ hasText: text });
}

async function states(table: string, column: string, ids: readonly string[]): Promise<string[]> {
  const rows = await sql<{ s: string }>(
    `select ${column}::text as s from app.${table} where id = any($1::uuid[]) order by id`,
    [ids],
  );
  return rows.map((r) => r.s);
}

async function timesheet(engagementId: string, start: string, end: string): Promise<string> {
  const [ts] = await sql<{ id: string }>(
    `insert into app.timesheets (project_id, engagement_id, period_start, period_end)
     select e.project_id, e.id, $2::date, $3::date from app.engagements e where e.id = $1 returning id`,
    [engagementId, start, end],
    PEOPLE.owner,
  );
  return ts?.id as string;
}

/**
 * Resolves once Realtime accepts the page's join of a private channel whose topic starts with
 * `prefix`. A change made before the join reaches no one, so a journey waits for it before acting.
 */
function channelJoined(page: Page, prefix: string): Promise<void> {
  return new Promise((resolve) => {
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const text = typeof payload === "string" ? payload : payload.toString("utf8");
        if (
          text.includes(`realtime:${prefix}`) &&
          text.includes("phx_reply") &&
          text.includes('"ok"')
        ) {
          resolve();
        }
      });
    });
  });
}

/**
 * Two consecutive days of a run's own: timesheets are told apart by their period, so each run
 * picks days no earlier run used. Returns the ISO dates and how the table writes them.
 */
function runDays(): { iso: [string, string]; label: [string, string] } {
  const start = Date.UTC(2027, 0, 1) + Math.floor(Math.random() * 3_000) * 86_400_000;
  const days = [new Date(start), new Date(start + 86_400_000)] as const;
  const iso = days.map((d) => d.toISOString().slice(0, 10)) as [string, string];
  const label = days.map((d) =>
    d.toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  ) as [string, string];
  return { iso, label };
}

async function bulkBar(page: Page): Promise<Locator> {
  const bar = page.getByRole("toolbar", { name: "Bulk actions" });
  await expect(bar).toBeVisible();
  return bar;
}

test("Gateway lists select, act in bulk, undo and update live", async ({ page }) => {
  const id = suffix();
  const engagement = await roleEngagement({
    person: ROLE_PEOPLE.staffOne,
    account: ROLE_ACCOUNTS.agency,
    roleType: "Staff",
  });
  await transition("engagement", engagement.id, "Onboarding", "Active", "Staffed for the run.");
  const first = `Site Rules ${id}`;
  const second = `Radio Protocol ${id}`;
  const docs = [
    (await sentDocument(engagement.id, "Agreement", first)).id,
    (await sentDocument(engagement.id, "Agreement", second)).id,
  ];
  const days = runDays();
  const sheets = [
    await timesheet(engagement.id, days.iso[0], days.iso[0]),
    await timesheet(engagement.id, days.iso[1], days.iso[1]),
  ];

  // Documents: select two and sign them in one call, after a preview.
  await signIn(page, "staff.one@example.com", "/documents");
  await page.goto("/documents?view=table");
  const documents = page.getByRole("grid");
  await expect(row(documents, first)).toBeVisible();
  await row(documents, first).getByRole("checkbox").click();
  await row(documents, second).getByRole("checkbox").click();
  await expect(page.getByRole("status").filter({ hasText: "2 selected" })).toBeAttached();
  await (await bulkBar(page)).getByRole("button", { name: "Sign 2 documents" }).click();
  const signing = page.getByRole("dialog", { name: "Sign 2 documents" });
  await expect(signing.getByText("2 documents will be signed in your name.")).toBeVisible();
  await expect(signing.getByText(/A signature is final/)).toBeVisible();
  await expectAccessible(page);
  await signing.getByRole("button", { name: "Sign 2 documents" }).click();
  await expect(page.getByText("Signed 2 documents.")).toBeVisible();
  await expect
    .poll(() => states("engagement_documents", "engagement_document_state", docs))
    .toEqual(["Signed", "Signed"]);

  // Live: a document the org sends now appears without a reload.
  const third = `Load-Out Plan ${id}`;
  await sentDocument(engagement.id, "Agreement", third);
  await expect(row(documents, third)).toBeVisible({ timeout: 60_000 });

  // Timesheets: a row's menu by right-click and by Shift+F10.
  await page.goto("/money/timesheets?view=table");
  const grid = page.getByRole("grid");
  const dayOne = row(grid, days.label[0]);
  const dayTwo = row(grid, days.label[1]);
  await expect(dayOne).toBeVisible();
  await dayOne.getByRole("gridcell").nth(1).click({ button: "right" });
  const menu = page.getByRole("menu", { name: new RegExp(`^Actions for ${days.label[0]}`) });
  await expect(menu.getByRole("menuitem", { name: "Submit" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Select" })).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await dayTwo.getByRole("gridcell").nth(1).focus();
  await page.keyboard.press("Shift+F10");
  await expect(
    page.getByRole("menu", { name: new RegExp(`^Actions for ${days.label[1]}`) }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // Submit both in bulk; Cmd or Ctrl+Z recalls them, Shift+Cmd or Ctrl+Z submits them again.
  await dayOne.getByRole("checkbox").click();
  await dayTwo.getByRole("checkbox").click();
  await (await bulkBar(page)).getByRole("button", { name: "Submit 2 timesheets" }).click();
  const submitting = page.getByRole("dialog", { name: "Submit 2 timesheets" });
  await expect(submitting.getByText("2 timesheets will be submitted for approval.")).toBeVisible();
  await submitting.getByRole("button", { name: "Submit 2 timesheets" }).click();
  await expect(page.getByText("Submitted 2 timesheets.")).toBeVisible();
  await expect
    .poll(() => states("timesheets", "timesheet_state", sheets))
    .toEqual(["Submitted", "Submitted"]);
  await page.locator("body").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() => states("timesheets", "timesheet_state", sheets))
    .toEqual(["Proposed", "Proposed"]);
  await expect(page.getByText("Undone: Submitted 2 timesheets.")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect
    .poll(() => states("timesheets", "timesheet_state", sheets))
    .toEqual(["Submitted", "Submitted"]);
  await expect(page.getByText("Redone: Submitted 2 timesheets.")).toBeVisible();
  await expectAccessible(page);

  // Live through the person's private channel: the engagement's state follows the org's change.
  const joined = channelJoined(page, "gateway:");
  await page.goto("/work/engagements?view=table");
  const engagements = page.getByRole("grid");
  const mine = engagements
    .getByRole("row")
    .filter({ has: page.getByText("Active") })
    .first();
  await expect(mine).toBeVisible();
  const before = await engagements.getByRole("row").filter({ hasText: "Closing" }).count();
  await joined;
  await transition("engagement", engagement.id, "Active", "Closing", "Run complete.");
  await expect(engagements.getByRole("row").filter({ hasText: "Closing" })).toHaveCount(
    before + 1,
    {
      timeout: 60_000,
    },
  );
});
