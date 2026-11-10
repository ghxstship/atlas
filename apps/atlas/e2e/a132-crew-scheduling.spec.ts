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
 * A132 crew scheduling (Section 4.5.6 item 25, Section 11.11 crew fill, ADR 0063): an owner keeps a shift template
 * in Settings, Scheduling, states their availability in Me, Work details, plans the template's shifts on a day from
 * the crew schedule, drags the person the board ranks first onto an open shift and watches the fill rate move, then
 * fills the other shift from the keyboard. Each run signs up a new owner in a new org, so runs never collide.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
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

test("A132: plan shifts from a template, drag a ranked person onto one and watch the fill rate", async ({
  page,
}) => {
  const id = uniqueId();
  const slug = `sch-${id}`;
  await signUp(page, { name: "Olive Owner", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Scheduling ${id}`, slug });
  await createProject(page, slug);
  const day = todayIn(NEW_PROJECT_TIME_ZONE);

  // Settings, Scheduling: a template for two stagehands, 08:00 to 16:00 with a 30-minute break.
  await page.goto(`/${slug}/settings/scheduling`);
  const add = page.getByRole("form", { name: "New shift template" });
  await add.getByLabel("Name").fill("Stagehand day");
  await add.getByLabel("Call time").fill("08:00");
  await add.getByLabel("Wrap time").fill("16:00");
  await add.getByLabel("People").fill("2");
  await add.getByLabel("Break (minutes)").fill("30");
  await add.getByRole("button", { name: "Add template" }).click();
  await expect(add.getByText("Template added.")).toBeVisible();
  const templates = page.getByTestId("shift-templates");
  await expect(templates.getByRole("rowheader", { name: "Stagehand day" })).toBeVisible();
  await expectAccessible(page);

  // Me, Work details: Available all of today and tomorrow (the calendar opens in the org's zone, UTC).
  await page.goto(`/${slug}/me/work-details`);
  const availability = page.getByRole("form", { name: "New availability period" });
  await availability.getByLabel(/^Starts/).fill(`${day}T00:00`);
  await availability.getByLabel(/^Ends/).fill(`${addDays(day, 1)}T23:59`);
  await availability.getByRole("button", { name: "Add period" }).click();
  await expect(availability.getByText("Period added.")).toBeVisible();
  await expect(page.getByTestId("my-availability").getByRole("list")).toContainText("Available");

  // Crew, Schedule: plan the template on today, two open Draft shifts.
  await page.goto(`/${slug}/crew/schedule?template=1`);
  const drawer = page.getByRole("dialog", { name: "Plan shifts from a template" });
  await drawer.getByLabel("First day").fill(day);
  await drawer.getByLabel("Last day").fill(day);
  await drawer.getByRole("button", { name: "Plan shifts" }).click();
  await expect(drawer).toBeHidden();

  const board = page.getByTestId("scheduling-board");
  const meter = board.getByRole("meter", { name: "Fill rate" });
  await expect(meter).toHaveAttribute("aria-valuetext", "0 of 2 shifts filled (0%)");
  await expect(board.getByTestId("board-open-shift")).toHaveCount(2);
  const first = board.getByTestId("board-candidate").first();
  await expect(first).toContainText("Olive Owner");
  await expect(first).toContainText("Available");
  await settle(page);
  await expectAccessible(page);

  // Drag the top-ranked person onto the first open shift: the meter moves and the move is announced.
  await first.dragTo(board.getByTestId("board-open-shift").first());
  await expect(meter).toHaveAttribute("aria-valuetext", "1 of 2 shifts filled (50%)");
  await expect(board.getByTestId("board-announcement")).toContainText("Olive Owner is on");
  await expect(board.getByTestId("board-open-shift")).toHaveCount(1);

  // The keyboard alternative: choose the remaining shift, then Assign on the person.
  await board.getByTestId("board-open-shift").first().getByRole("button").focus();
  await page.keyboard.press("Enter");
  const assign = board.getByRole("button", { name: /^Assign Olive Owner to / });
  await expect(assign).toBeEnabled();
  await assign.focus();
  await page.keyboard.press("Enter");
  await expect(meter).toHaveAttribute("aria-valuetext", "2 of 2 shifts filled (100%)");
  await expect(board.getByText("Every shift this week has someone on it.")).toBeVisible();
  // The schedule rereads: both shifts sit on the owner's row, marked as a double booking.
  await expect(page.getByText("Double booked")).toBeVisible();
  await expectAccessible(page);
});
