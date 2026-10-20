import { expect, test, type Browser, type Page } from "./engine-test";
import {
  createOrganization,
  expectAccessible,
  PASSWORD,
  signUp,
  testEmail,
  uniqueId,
} from "./support";

/**
 * A13 Crew journeys (Section 20.2): 10 (publish a shift, the crew member accepts and clocks in, a
 * second clock in for the same time is refused, then clocks out), 11 (a supervisor approves the
 * timesheet, the hours change and the approval is voided), 12 and 31 (payroll export is plan gated
 * and Restricted), and 66 (crew claim a published open shift). Each run signs up a new owner in a new
 * org with a project and a Field member, so runs never collide on the shared stack. Every page is
 * checked with axe in both themes.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
expect.configure({ timeout: 20_000 });

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

function today(): string {
  return new Date().toISOString().slice(0, 10);
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
  await open.first().click();
  await confirm(field, "Claim shift");
  await field.goto(`/${slug}/crew/shifts?view=list`);
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
