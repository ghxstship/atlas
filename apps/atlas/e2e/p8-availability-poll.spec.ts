import { expect as baseExpect, settle, test } from "./engine-test";
import { expectAccessible } from "./support";
import { createProject, newOwnerOrg } from "./p8-support";

/**
 * P8 (RRR-222, parity gap G-124; Section 4.5.6 item 25): an availability poll in Atlas. The Owner, a planner and a
 * member of the org, asks for availability on two days of a project from Crew > Shifts, is notified in the Inbox,
 * answers in Me, Work details (Requests), and reads the answers in the poll's person-by-day grid, each shown as text
 * with an icon.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

/** A YYYY-MM-DD day `n` days after today in UTC, far enough ahead to be a future day on any calendar. */
function dayFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

test("ask for availability, answer it and read the results", async ({ page }) => {
  const slug = await newOwnerOrg(page, "p8poll", "Pat Planner");
  await createProject(page, slug, "PAV", "Availability Week");
  const first = dayFromNow(10);
  const last = dayFromNow(11);

  await page.goto(`/${slug}/crew/shifts`);
  await page.getByRole("link", { name: "Ask for availability" }).click();
  const polls = page.getByRole("region", { name: "Availability polls" });
  await expect(polls).toContainText("No poll yet.");
  await polls.getByRole("button", { name: "New poll" }).click();
  const dialog = page.getByRole("dialog", { name: "Ask for availability" });
  await dialog.getByLabel("Title").fill("Load-in week");
  await dialog.getByLabel("First day").fill(first);
  await dialog.getByLabel("Last day").fill(last);
  await expect(dialog.getByText("Asks about 2 days.")).toBeVisible();
  await dialog.getByLabel("Search people").fill("Pat");
  await dialog.getByLabel("Pat Planner").check();
  await settle(page);
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Ask 1 person" }).click();
  await expect(dialog).toBeHidden();
  await expect(polls).toContainText("Load-in week");
  await expect(polls.getByRole("table")).toContainText("Not stated");

  // The recipient is notified in the Inbox, and answers in Me, Work details.
  await page.goto(`/${slug}/inbox`);
  await expect(page.getByText(/asks for your availability: Load-in week/).first()).toBeVisible();
  await page.goto(`/${slug}/me/work-details`);
  const requests = page.getByRole("region", { name: "Availability request" });
  await expect(requests).toContainText("shared with its planners");
  const selects = requests.getByRole("combobox");
  await selects.nth(0).selectOption("Available");
  await selects.nth(1).selectOption("Unavailable");
  await requests.getByRole("button", { name: "Send answers" }).click();
  await expect(requests.getByText("Saved 2 answers.")).toBeAttached();

  // The planner reads the answers by person and day.
  await page.goto(`/${slug}/crew/shifts?poll=1`);
  const grid = page.getByRole("region", { name: "Availability polls" }).getByRole("table");
  await expect(grid).toContainText("Available");
  await expect(grid).toContainText("Unavailable");
  await expect(grid).not.toContainText("Not yet");
});
