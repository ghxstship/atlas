import { expect as baseExpect, settle, test, type Page } from "./engine-test";
import {
  createOrganization,
  expectAccessible,
  NEW_PROJECT_TIME_ZONE,
  signUp,
  testEmail,
  todayIn,
  uniqueId,
} from "./support";

/**
 * B9 crew coverage (ADR 0148, S4.5.5-01, S11.11-01): an owner adds a position on Crew > Positions and plans an open shift
 * held for it, which the drag board lists apart and Crew > Shortages names as an unfilled position. Filling the position
 * gives the shift to the owner, with the outcome as a notice on the page, and the shift leaves Shortages. Scheduling limits
 * then warn on the board: Assign asks "Assign anyway", from the keyboard, and never refuses. The five standard crew reports
 * open unsaved in the builder. Each run signs up a new owner in a new org, so runs never collide.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 20_000 });

async function createProject(page: Page, slug: string) {
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill("NWL");
  await dialog.getByLabel("Project name").fill("Northwind Summer Series");
  await dialog.getByRole("button", { name: "More fields" }).click();
  await dialog.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await dialog.getByLabel("Tier of experience").selectOption({ index: 5 });
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/NWL/overview`);
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

test("B9: a position holds a shift until it is filled, shortages name it, and warnings ask without refusing", async ({
  page,
}) => {
  const id = uniqueId();
  const slug = `cov-${id}`;
  await signUp(page, { name: "Olive Owner", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Coverage ${id}`, slug });
  await createProject(page, slug);
  // Tomorrow in the project's zone, so the shift has not started however late the run is.
  const day = addDays(todayIn(NEW_PROJECT_TIME_ZONE), 1);

  // Nothing is short yet, and the empty state offers the planner one way forward.
  await page.goto(`/${slug}/crew/shortages`);
  await expect(page.getByText("Nothing uncovered in these dates.")).toBeVisible();

  // A position, from the page's one primary action.
  await page.goto(`/${slug}/crew/positions?create=1`);
  const create = page.getByRole("dialog", { name: "New position" });
  await create.getByLabel("Title", { exact: true }).fill("Stage Manager");
  await create.getByRole("button", { name: "New position" }).click();
  await expect(create).toBeHidden();
  const positions = page.getByRole("grid", { name: "Positions" });
  await expect(positions.getByRole("gridcell", { name: "Stage Manager" })).toBeVisible();
  await expect(positions.getByRole("gridcell", { name: "Unfilled position" })).toBeVisible();
  await expectAccessible(page);

  // An open shift held for it.
  await page.goto(`/${slug}/crew/schedule?create=1&week=${day}`);
  const shift = page.getByRole("dialog", { name: "New shift" });
  await shift
    .getByLabel("Position", { exact: true })
    .selectOption({ label: "NWL · Stage Manager" });
  await shift.getByLabel(/^Starts/).fill(`${day}T08:00`);
  await shift.getByLabel(/^Ends/).fill(`${day}T16:00`);
  await shift.getByRole("button", { name: "New shift" }).click();
  await expect(shift).toBeHidden();

  // The board lists it apart, linked to the position, and it still counts as unfilled.
  const board = page.getByTestId("scheduling-board");
  await expect(board.getByTestId("board-held-shifts")).toContainText("Stage Manager");
  await expect(board.getByTestId("board-open-shift")).toHaveCount(0);
  await expect(board.getByRole("meter", { name: "Fill rate" })).toHaveAttribute(
    "aria-valuetext",
    "0 of 1 shifts filled (0%)",
  );

  // Shortages names the position, in a range that holds the shift.
  await page.goto(`/${slug}/crew/shortages?from=${day}&to=${addDays(day, 3)}`);
  await expect(page.getByText("Unfilled position: Stage Manager")).toBeVisible();
  await expectAccessible(page);

  // Filling it: the drawer leaves, and what filling did is a notice on the page.
  await page.goto(`/${slug}/crew/positions?view=list`);
  await page.getByRole("link", { name: /Stage Manager/ }).click();
  await settle(page);
  await page.getByRole("link", { name: "Fill position" }).click();
  const fill = page.getByRole("dialog", { name: "Fill Stage Manager" });
  await fill.getByLabel("Member").selectOption({ label: "Olive Owner" });
  await fill.getByRole("button", { name: "Fill position" }).click();
  await expect(page.getByText("Position filled")).toBeVisible();
  await expect(page.getByText("1 shift filled", { exact: false })).toBeVisible();

  await page.goto(`/${slug}/crew/shortages?from=${day}&to=${addDays(day, 3)}`);
  await expect(page.getByText("Unfilled position: Stage Manager")).toBeHidden();

  // A warned person is asked about, from the keyboard, and then assigned.
  await page.goto(`/${slug}/settings/scheduling`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  const settings = page.getByRole("form", { name: "Settings on this page" });
  const daily = settings.getByLabel("Maximum scheduled hours in a day");
  // The page shows seven fields; the limits sit under More fields.
  await expect(async () => {
    if (!(await daily.isVisible())) {
      await settings.getByRole("button", { name: "More fields" }).first().click();
    }
    await expect(daily).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await daily.fill("1");
  const save = settings.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect(save).toHaveCount(0);
  await page.goto(`/${slug}/crew/schedule?create=1&week=${day}`);
  const open = page.getByRole("dialog", { name: "New shift" });
  await open.getByLabel(/^Starts/).fill(`${day}T18:00`);
  await open.getByLabel(/^Ends/).fill(`${day}T22:00`);
  await open.getByRole("button", { name: "New shift" }).click();
  await expect(open).toBeHidden();
  const assign = board.getByRole("button", { name: /^Assign Olive Owner to / });
  await expect(assign).toBeEnabled();
  await expect(board.getByTestId("board-candidate").first()).toContainText("Over 1 h that day");
  await assign.focus();
  await page.keyboard.press("Enter");
  const ask = board.getByTestId("board-assign-anyway");
  await expect(ask).toContainText("Over 1 h that day");
  await expect(board.getByTestId("board-announcement")).toContainText("Over 1 h that day");
  await expect(ask.getByRole("button", { name: "Assign anyway" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(board.getByTestId("board-announcement")).toContainText("Olive Owner is on");

  // The standard crew reports open unsaved.
  await page.goto(`/${slug}/reports/saved-reports`);
  await expect(page.getByRole("heading", { name: "Standard crew reports" })).toBeVisible();
  await page.getByRole("link", { name: "Open Crew utilization" }).click();
  await expect(page.getByRole("button", { name: "Save as my report" })).toBeVisible();
  await expectAccessible(page);
});
