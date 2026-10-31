import pg from "pg";
import { DEMO_ORG, signInAs } from "./a36-support";
import { expect as baseExpect, settle, test, type Browser, type Page } from "./engine-test";
import {
  createOrganization,
  expectAccessible,
  NEW_PROJECT_TIME_ZONE,
  PASSWORD,
  signUp,
  testEmail,
  todayIn,
  uniqueId,
} from "./support";

/**
 * A13 Crew journeys (Section 20.2): 10 (publish a shift, the crew member accepts and clocks in, a
 * second clock in for the same time is refused, then clocks out), 11 (a supervisor approves the
 * timesheet, the hours change and the approval is voided), 12 and 31 (payroll export is plan gated
 * and Restricted), and 66 (crew claim a published open shift under the org's claiming rule: approval by
 * default, so a supervisor approves the claim). Each run signs up a new owner in a new
 * org with a project and a Field member, so runs never collide on the shared stack. Every page is
 * checked with axe in both themes. R12's agency staff run in the demo org, on the staffing agency of
 * seed 1080, as the last test.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
// expect.configure returns a configured expect; called on its own it changed nothing (A71).
const expect = baseExpect.configure({ timeout: 20_000 });

/** Panels fade in; axe runs once the fade has settled so it measures final colors. */
async function settled(page: Page) {
  await page.waitForTimeout(400);
  await expectAccessible(page);
}

async function expectAccessibleInBothThemes(page: Page) {
  await settled(page);
  await page.context().addCookies([{ name: "xos-theme", value: "light", url: page.url() }]);
  await page.reload();
  await settled(page);
  await page.context().addCookies([{ name: "xos-theme", value: "dark", url: page.url() }]);
  await page.reload();
  // Leave the page hydrated: callers act next, and a click before hydration is lost (A71, A77).
  await settle(page);
}

interface Crew {
  slug: string;
  owner: Page;
  field: Page;
  fieldName: string;
}

async function createProject(page: Page, slug: string, key: string, name: string) {
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill(key);
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "More fields" }).click();
  await dialog.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await dialog.getByLabel("Tier of experience").selectOption({ index: 5 });
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/${key}/overview`);
}

/** A new org with project NWL and a Field member who accepted their invitation. */
async function newCrew(page: Page, browser: Browser): Promise<Crew> {
  const id = uniqueId();
  const slug = `crw-${id}`;
  const fieldEmail = testEmail("field", id);
  const fieldName = `Fern Field ${id}`;
  await signUp(page, { name: "Olive Owner", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Crew ${id}`, slug });
  await createProject(page, slug, "NWL", "Northwind Summer Series");
  // A New York production: the org's time zone is the project's (journey 63's setting).
  await page.goto(`/${slug}/settings/localization`);
  const settings = page.getByRole("form", { name: "Settings on this page" });
  const zone = settings.locator("li").filter({ has: page.getByLabel("Time zone") });
  await zone.getByLabel("Time zone").selectOption(NEW_PROJECT_TIME_ZONE);
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(zone.getByText(/Set for the organization/)).toBeVisible();
  await page.goto(`/${slug}/settings/members`);
  await page.getByLabel("Email", { exact: true }).fill(fieldEmail);
  await page.locator("#invite-role").selectOption({ label: "Field" });
  await page.getByRole("button", { name: "Create invite" }).click();
  const link = page.locator("#invite-link");
  await expect(link).toHaveValue(/\/auth\/invite\/xinv_/, { timeout: 30_000 });
  const inviteUrl = new URL(await link.inputValue());
  const field = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await field.goto(inviteUrl.pathname);
  await field.getByLabel(/^Full name$/).fill(fieldName);
  await field.locator("#signup-email").fill(fieldEmail);
  await field.locator("#signup-password").fill(PASSWORD);
  await field.locator("#signup-age").check();
  await field.getByRole("button", { name: "Create account" }).click();
  await field.getByRole("button", { name: "Accept invitation" }).click();
  await field.waitForURL(`**/${slug}/home`);
  return { slug, owner: page, field, fieldName };
}

/**
 * Today in project NWL's zone, where the shift and time entry forms take their times (A71). The org is
 * set to the same zone (newCrew), so its org-wide crew week is that calendar too; left on UTC, the
 * default, its week ran a day ahead of New York in the evening and lost Sunday night's shifts.
 */
function today(): string {
  return todayIn(NEW_PROJECT_TIME_ZONE);
}

async function confirm(page: Page, button: string, confirmLabel = button) {
  await page.getByRole("button", { name: button, exact: true }).first().click();
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("button", { name: "Cancel", exact: true }) });
  await expect(dialog).toBeVisible();
  // Let the dialog's entrance fade settle before axe measures contrast.
  await page.waitForTimeout(400);
  await expectAccessible(page);
  await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("journeys 10 and 11: publish, accept, clock in and out, approve, and void on edit", async ({
  page,
  browser,
}) => {
  const crew = await newCrew(page, browser);
  const { slug, owner, field } = crew;

  // Planner: an empty week names the next action, then a new shift for the Field member.
  await owner.goto(`/${slug}/crew/shifts?view=table`);
  await expect(owner.getByText(/No shifts in this period/)).toBeVisible();
  await expectAccessibleInBothThemes(owner);
  await owner.getByRole("link", { name: "New shift" }).first().click();
  const drawer = owner.getByRole("dialog", { name: "New shift" });
  await expect(drawer).toBeVisible();
  await owner.waitForTimeout(400);
  await expectAccessible(owner);
  await drawer.getByLabel("Person").selectOption({ label: crew.fieldName });
  await drawer.getByLabel(/^Starts/).fill(`${today()}T00:05`);
  await drawer.getByLabel(/^Ends/).fill(`${today()}T23:55`);
  await drawer.getByRole("button", { name: "New shift" }).click();
  await expect(drawer).toBeHidden();
  const row = owner.getByRole("row").filter({ hasText: crew.fieldName });
  await expect(row).toContainText("Draft");

  // The resource schedule shows the person and the drafted shift.
  await owner.goto(`/${slug}/crew/schedule`);
  await expect(owner.getByRole("table", { name: "Crew schedule by person and day" })).toContainText(
    crew.fieldName,
  );
  await expectAccessibleInBothThemes(owner);

  // Publish from the toolbar; the peek shows the move in its history.
  await confirm(owner, "Publish 1 draft", "Publish 1 draft");
  await owner.getByRole("link", { name: /Published shift on NWL/ }).click();
  const peek = owner.getByRole("dialog").filter({ hasText: "Shift" });
  await expect(peek).toContainText("Moved from Draft to Published");
  // The shift carries the comment thread.
  await peek.getByLabel("Write a comment").fill("Bring gloves for the truck.");
  await peek.getByRole("button", { name: "Post comment" }).click();
  await expect(peek.getByText("Bring gloves for the truck.")).toBeVisible();
  await owner.waitForTimeout(400);
  await expectAccessible(owner);

  // Crew member: accept, clock in, and clock out.
  await field.goto(`/${slug}/crew/shifts?view=list`);
  await field
    .getByRole("link", { name: /No role set/ })
    .first()
    .click();
  await confirm(field, "Accept shift");
  await expect(field.getByRole("dialog").first()).toContainText("Accepted");
  await confirm(field, "Clock in");
  await expect(field.getByText("Time on this shift")).toBeVisible();

  // A second clock in over the same time, from another device or by a supervisor, is refused.
  await owner.goto(`/${slug}/crew/time-entries?create=1`);
  const entry = owner.getByRole("dialog", { name: "Record time" });
  await entry.getByLabel("Person").selectOption({ label: crew.fieldName });
  await entry.getByLabel(/^Clock in/).fill(`${today()}T00:01`);
  await entry.getByLabel(/^Clock out/).fill(`${today()}T23:59`);
  await entry.getByRole("button", { name: "Record time" }).click();
  await expect(entry.getByText(/already has time recorded for part of that period/)).toBeVisible();
  await owner.waitForTimeout(400);
  await expectAccessible(owner);
  await entry.getByRole("button", { name: "Cancel" }).click();

  await field.reload();
  await confirm(field, "Clock out");

  // Crew member: open this week's timesheet and submit it.
  await field.goto(`/${slug}/crew/timesheets?create=1`);
  const sheetForm = field.getByRole("dialog", { name: "New timesheet" });
  await expect(sheetForm).toBeVisible();
  await sheetForm.getByRole("button", { name: "New timesheet" }).click();
  await expect(sheetForm).toBeHidden();
  await field.getByRole("row").filter({ hasText: crew.fieldName }).first().dblclick();
  await confirm(field, "Submit for approval");
  await expectAccessibleInBothThemes(field);

  // Supervisor: approve; the approval stands.
  await owner.goto(`/${slug}/crew/timesheets?state=Submitted`);
  await expect(owner.getByText(/1 timesheet waits for approval/)).toBeVisible();
  await owner.getByRole("row").filter({ hasText: crew.fieldName }).first().dblclick();
  await confirm(owner, "Approve");
  await expect(owner.getByRole("dialog").first()).toContainText("Approved");

  // Supervisor: the hours change, so the approval is voided and the timesheet returns to Draft.
  await owner.goto(`/${slug}/crew/time-entries`);
  await owner.getByRole("row").filter({ hasText: crew.fieldName }).first().dblclick();
  await owner.getByRole("link", { name: "Edit" }).click();
  const edit = owner.getByRole("dialog", { name: "Edit time entry" });
  await edit.getByLabel(/^Clock in/).fill(`${today()}T01:00`);
  await edit.getByLabel(/^Clock out/).fill(`${today()}T05:00`);
  await edit.getByLabel("Unpaid break minutes").fill("30");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await owner.goto(`/${slug}/crew/timesheets`);
  await owner.getByRole("row").filter({ hasText: crew.fieldName }).first().dblclick();
  await expect(owner.getByText("An earlier approval was voided")).toBeVisible();
  await expect(owner.getByRole("dialog").first()).toContainText("Moved from Approved to Draft");
  await expectAccessibleInBothThemes(owner);
});

test("journey 66: crew claim a published open shift; a double booking is refused", async ({
  page,
  browser,
}) => {
  const { slug, owner, field } = await newCrew(page, browser);
  for (const [start, end] of [
    ["T09:00", "T17:00"],
    ["T10:00", "T14:00"],
  ]) {
    await owner.goto(`/${slug}/crew/shifts?create=1`);
    const drawer = owner.getByRole("dialog", { name: "New shift" });
    await drawer.getByLabel(/^Starts/).fill(`${today()}${start}`);
    await drawer.getByLabel(/^Ends/).fill(`${today()}${end}`);
    await drawer.getByRole("button", { name: "New shift" }).click();
    await expect(drawer).toBeHidden();
  }
  await owner.goto(`/${slug}/crew/shifts`);
  await confirm(owner, "Publish 2 drafts", "Publish 2 drafts");

  await field.goto(`/${slug}/crew/shifts?view=list`);
  await expectAccessibleInBothThemes(field);
  const open = field.getByRole("link", { name: /Open shift/ });
  await expect(open).toHaveCount(2);
  // The org keeps the default claiming rule, approval (scheduling.open_shift_claiming): the claim waits.
  await open.first().click();
  await confirm(field, "Claim shift");
  await expect(field.getByText("Your claim is waiting for a supervisor to decide.")).toBeVisible();

  // The Owner approves the waiting claim, and the shift is the field member's.
  await owner.goto(`/${slug}/crew/shifts?view=list`);
  await owner
    .getByRole("link", { name: /Open shift/ })
    .first()
    .click();
  await expect(owner.getByRole("heading", { name: "Waiting claims" })).toBeVisible();
  await confirm(owner, "Approve");
  await expectAccessible(owner);

  // Claiming the other shift, which overlaps the one now held, is refused as a double booking.
  await field.goto(`/${slug}/crew/shifts?view=list`);
  await expect(field.getByRole("link", { name: /Open shift/ })).toHaveCount(1);
  await field
    .getByRole("link", { name: /Open shift/ })
    .first()
    .click();
  await field.getByRole("button", { name: "Claim shift", exact: true }).click();
  const dialog = field.getByRole("dialog").last();
  await dialog.getByRole("button", { name: "Claim shift", exact: true }).click();
  await expect(dialog.getByText("You already hold a shift that overlaps this one.")).toBeVisible();
  await expectAccessible(field);
});

test("journeys 12 and 31: pay rates by role, a posted period never reopens, export is plan gated", async ({
  page,
  browser,
}) => {
  const { slug, owner, field, fieldName } = await newCrew(page, browser);

  // Rate cards and the pay rate ledger: the Owner holds the payroll restricted read.
  await owner.goto(`/${slug}/crew/rate-cards?create=1`);
  const card = owner.getByRole("dialog", { name: "New rate card" });
  await card.getByLabel("Rate card name").fill("2027 Crew Rates");
  await card.getByRole("button", { name: "New rate card" }).click();
  await expect(owner.getByRole("heading", { level: 2, name: "2027 Crew Rates" })).toBeVisible();
  await owner.getByRole("link", { name: "Record pay rate" }).click();
  const rate = owner.getByRole("dialog", { name: "Record a pay rate" });
  await rate.getByLabel("Person").selectOption({ label: fieldName });
  await rate.getByLabel("Hourly rate").fill("32.50");
  await rate.getByRole("button", { name: "Record pay rate" }).click();
  await expect(rate).toBeHidden();
  await expect(owner.getByRole("grid", { name: "Pay rate ledger" })).toContainText("$32.50");
  await expectAccessibleInBothThemes(owner);

  // Pay periods: open, start a run, cancel it, close and post; a posted period offers no reopen.
  await owner.goto(`/${slug}/crew/pay-periods?create=1`);
  const period = owner.getByRole("dialog", { name: "New pay period" });
  await period.getByRole("button", { name: "New pay period" }).click();
  await expect(period).toBeHidden();
  await owner.getByRole("row").nth(1).dblclick();
  await owner.getByRole("link", { name: "New payroll run" }).click();
  const run = owner.getByRole("dialog", { name: "New payroll run" });
  await run.getByRole("button", { name: "New payroll run" }).click();
  await expect(run).toBeHidden();
  await owner.getByRole("link", { name: /USD run started/ }).click();
  await expect(owner.getByText(/No lines yet\. Calculate the run/)).toBeVisible();
  await settled(owner);
  await confirm(owner, "Cancel run");
  await owner.goto(`/${slug}/crew/pay-periods`);
  await owner.getByRole("row").nth(1).dblclick();
  await confirm(owner, "Close period");
  await confirm(owner, "Post period");
  const posted = owner.getByRole("dialog").first();
  await expect(posted).toContainText("Moved from Closed to Posted");
  await expect(posted.getByRole("button", { name: "Reopen period" })).toHaveCount(0);
  await expectAccessibleInBothThemes(owner);

  // Payroll export starts at Team: an Access org sees the refusal with its reason.
  await owner.goto(`/${slug}/crew/payroll-exports`);
  await expect(
    owner.getByText(/Payroll export is included from the Team plan/).first(),
  ).toBeVisible();
  await expectAccessibleInBothThemes(owner);

  // The Field member reads their own pay rate in the ledger.
  await field.goto(`/${slug}/crew/rate-cards`);
  await expect(field.getByRole("grid", { name: "Pay rate ledger" })).toContainText("$32.50");
  await expectAccessibleInBothThemes(field);
});

// R12 agency staff on shifts (RRR-190) ---------------------------------------------------------------------------------

const DEMO_ORG_ID = "01920000-0000-7000-8000-000000000001";
const DEMO_OWNER = "01920000-0000-7000-8000-000000000101";
const DEMO_PROJECT_ID = "01920000-0000-7000-8000-000000001001";
const AGENCY = {
  owner: "01920000-0000-7000-8000-000010800101",
  staffOne: "01920000-0000-7000-8000-000010800102",
  staffTwo: "01920000-0000-7000-8000-000010800103",
  account: "01920000-0000-7000-8000-000010800301",
} as const;
/** Inside the demo project's Pier Site geofence (seed 0109): the project requires it on phone punches. */
const PIER = { latitude: 25.7752, longitude: -80.1855, accuracy: 10 };

/** One statement as postgres against the local stack only, under `person`'s claims when given. */
async function localSql<T extends Record<string, unknown>>(
  text: string,
  args: unknown[] = [],
  person?: string,
): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error("The agency staff journey builds its roster only on a local Supabase stack.");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    if (person) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: person, role: "authenticated" }),
      ]);
    }
    const result = await client.query(text, args);
    await client.query("commit");
    return result.rows as T[];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * The staffing agency's Staff company engagement on the demo project (it names no person, so shifts naming it are
 * agency slots), with Staff One and Two on its roster: the agency submits, each accepts, the demo Owner accepts both
 * entries, and the engagement is Active. Returns the engagement and the two entry ids.
 */
async function agencyOnProject(): Promise<{ engagement: string; one: string; two: string }> {
  const [row] = await localSql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
       pay_basis, arrangement, agreed_rate_minor, currency_code, start_date, end_date)
     values ($1, null,
       (select c.id from app.counterparties c where c.org_id = $2 and c.organization_id = $3 and c.deleted_at is null limit 1),
       'Staff', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 30000, 'USD', current_date - 1, current_date + 7)
     returning id`,
    [DEMO_PROJECT_ID, DEMO_ORG_ID, AGENCY.account],
    DEMO_OWNER,
  );
  const engagement = row?.id as string;
  const ids: string[] = [];
  for (const person of [AGENCY.staffOne, AGENCY.staffTwo]) {
    const [entry] = await localSql<{ id: string }>(
      "select app.add_roster_entry($1, $2) as id",
      [engagement, person],
      AGENCY.owner,
    );
    ids.push(entry?.id as string);
  }
  await localSql("select app.submit_roster($1)", [engagement], AGENCY.owner);
  for (const [index, person] of [AGENCY.staffOne, AGENCY.staffTwo].entries()) {
    await localSql("select app.respond_roster_entry($1, 'Accepted')", [ids[index]], person);
    await localSql("select app.review_roster_entry($1, 'Accepted')", [ids[index]], DEMO_OWNER);
  }
  await localSql(
    `select private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state',
       'app.engagement_state_transitions', 'engagement_id', $1::uuid, 'Onboarding', 'Active', 'Roster accepted.')`,
    [engagement],
  );
  return { engagement, one: ids[0] as string, two: ids[1] as string };
}

/** The demo project's local date, in which the shift editor takes its times. */
function projectDay(): string {
  return todayIn(NEW_PROJECT_TIME_ZONE);
}

test("R12: allocate an agency slot, drag agency staff onto an open shift, and the punching supervisor never approves", async ({
  page,
}) => {
  const [names] = await localSql<{ two: string; owner: string; party: string }>(
    `select (select full_name from app.people where id = $1) as two,
            (select full_name from app.people where id = $2) as owner,
            (select name from app.organizations where id = $3) as party`,
    [AGENCY.staffTwo, DEMO_OWNER, AGENCY.account],
  );
  const staffTwo = names?.two ?? "";
  const party = names?.party ?? "";
  const agency = await agencyOnProject();
  try {
    await signInAs(page, "owner@example.com", DEMO_ORG);

    // Allocate an agency slot: the shift editor's Person field lists the agency, loaded as the editor opens.
    await page.goto(`/${DEMO_ORG}/p/NWS/crew?create=1`);
    const drawer = page.getByRole("dialog", { name: "New shift" });
    await expect(drawer).toBeVisible();
    await drawer.getByLabel("Person").selectOption(`agency:${agency.engagement}`);
    await drawer.getByLabel(/^Starts/).fill(`${projectDay()}T19:00`);
    await drawer.getByLabel(/^Ends/).fill(`${projectDay()}T23:00`);
    await drawer.getByRole("button", { name: "New shift" }).click();
    await expect(drawer).toBeHidden();
    await expect
      .poll(async () => {
        const [slot] = await localSql<{ n: number }>(
          `select count(*)::int as n from app.shifts where engagement_id = $1 and roster_entry_id is null
             and deleted_at is null`,
          [agency.engagement],
        );
        return slot?.n ?? 0;
      })
      .toBe(1);
    await expect(page.getByText(`Agency slot: ${party}`, { exact: false }).first()).toBeVisible();
    await page.waitForTimeout(400);
    await expectAccessible(page);

    // The drag board ranks the agency's accepted people beside the members; Staff Two dropped on an open shift
    // fills it, and the meter moves.
    const [open] = await localSql<{ id: string }>(
      `insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
       values ($1, '5000.51.02', ($2::date + time '05:17') at time zone $3, ($2::date + time '06:43') at time zone $3, $3)
       returning id`,
      [DEMO_PROJECT_ID, projectDay(), NEW_PROJECT_TIME_ZONE],
      DEMO_OWNER,
    );
    await page.goto(`/${DEMO_ORG}/crew/schedule`);
    const board = page.getByTestId("scheduling-board");
    const meter = board.getByRole("meter", { name: "Fill rate" });
    const target = board.getByTestId("board-open-shift").filter({ hasText: /5:17/ });
    await expect(target).toHaveCount(1);
    await target.getByRole("button").click();
    const before = /^(\d+) of (\d+)/.exec((await meter.getAttribute("aria-valuetext")) ?? "");
    const filled = Number(before?.[1] ?? 0);
    const total = Number(before?.[2] ?? 0);
    const candidate = board
      .getByTestId("board-candidate")
      .filter({ hasText: staffTwo })
      .and(board.locator('[data-kind="staff"]'));
    await expect(candidate).toContainText(`Agency staff, ${party}`);
    await settle(page);
    await expectAccessible(page);
    await candidate.dragTo(target);
    await expect(board.getByTestId("board-announcement")).toContainText(`${staffTwo} is on`);
    await expect(meter).toHaveAttribute(
      "aria-valuetext",
      new RegExp(`^${filled + 1} of ${total} shifts filled`),
    );
    await expect
      .poll(async () => {
        const [held] = await localSql<{ entry: string | null }>(
          "select roster_entry_id as entry from app.shifts where id = $1",
          [open?.id],
        );
        return held?.entry ?? null;
      })
      .toBe(agency.two);

    // The demo Owner clocks Staff One in and out as their supervisor (Compass's team punch), so they are kept
    // from approving the timesheet holding that time (sod_supervisor_punch).
    const [now] = await localSql<{ id: string }>(
      `insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
       values ($1, $2, '5000.51.02', now() - interval '1 hour', now() + interval '6 hours', $3) returning id`,
      [DEMO_PROJECT_ID, agency.engagement, NEW_PROJECT_TIME_ZONE],
      DEMO_OWNER,
    );
    await localSql("select app.assign_roster_shift($1, $2)", [now?.id, agency.one], DEMO_OWNER);
    for (const [kind, ago] of [
      ["In", "30 minutes"],
      ["Out", "0 minutes"],
    ] as const) {
      const [punched] = await localSql<{ outcome: string }>(
        `select app.record_supervisor_punches(gen_random_uuid(), $1, $2::app.punch_kind, now() - $3::interval,
           jsonb_build_array(jsonb_build_object('punch_id', gen_random_uuid(), 'shift_id', $4::uuid)),
           null, $5, $6, $7, null) -> 'results' -> 0 ->> 'outcome' as outcome`,
        [DEMO_PROJECT_ID, kind, ago, now?.id, PIER.latitude, PIER.longitude, PIER.accuracy],
        DEMO_OWNER,
      );
      expect(punched?.outcome).toBe("applied");
    }
    const [sheet] = await localSql<{ id: string }>(
      `insert into app.timesheets (project_id, roster_entry_id, period_start, period_end)
       values ($1, $2, $3::date - 1, $3::date + 1) returning id`,
      [DEMO_PROJECT_ID, agency.one, projectDay()],
      DEMO_OWNER,
    );
    await localSql("select app.submit_timesheet($1)", [sheet?.id], AGENCY.staffOne);
    await page.goto(`/${DEMO_ORG}/crew/timesheets?state=Submitted&peek=${sheet?.id}`);
    const detail = page.getByRole("dialog").first();
    await expect(detail).toContainText(`Clocked by ${names?.owner ?? ""}`);
    await expect(detail).toContainText(
      "You punched this person in or out, so someone else approves this timesheet.",
    );
    await expect(detail.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await page.waitForTimeout(400);
    await expectAccessible(page);
  } finally {
    for (const statement of [
      "update app.timesheets set deleted_at = now() where roster_entry_id in (select id from app.engagement_roster_entries where engagement_id = $1) and deleted_at is null",
      "update app.shifts set deleted_at = now() where (engagement_id = $1 or roster_entry_id in (select id from app.engagement_roster_entries where engagement_id = $1)) and deleted_at is null",
      "update app.engagement_roster_entries set deleted_at = now() where engagement_id = $1 and deleted_at is null",
      "update app.engagements set deleted_at = now() where id = $1",
    ]) {
      await localSql(statement, [agency.engagement]).catch(() => undefined);
    }
  }
});
