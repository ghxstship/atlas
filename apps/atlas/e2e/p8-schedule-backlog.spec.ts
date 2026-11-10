import { expect as baseExpect, settle, test } from "./engine-test";
import { expectAccessible } from "./support";
import { createProject, createTask, newOwnerOrg } from "./p8-support";

/**
 * P8 (RRR-222, parity gap G-36; Section 11.11): the schedule's Unscheduled list. Records with no dates wait beside the
 * timeline, which still draws the project's days when nothing is dated. One is scheduled from the keyboard (Schedule,
 * a day, Preview, Apply) and comes back on Undo; another is dragged onto a day. A Task placed on a day runs 09:00
 * to 17:00 project time and draws as a bar.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("place undated records from the Unscheduled list, by keyboard and by drag", async ({
  page,
}) => {
  const slug = await newOwnerOrg(page, "p8backlog", "Bo Backlog");
  await createProject(page, slug, "PBL", "Backline Day");
  const first = await createTask(page, slug, "Tune the backline");
  const second = await createTask(page, slug, "Label the cables");

  await page.goto(`/${slug}/schedule/timeline?project=PBL`);
  const list = page.getByRole("region", { name: "Unscheduled (2)" });
  await expect(list).toBeVisible();
  await expect(list).toContainText(`${first} Tune the backline`);
  await settle(page);
  await expectAccessible(page);

  // Keyboard: Schedule, choose the day, preview, apply.
  await list.getByRole("button", { name: `Schedule ${first} Tune the backline` }).click();
  await list.getByLabel(`Day for ${first} Tune the backline`).selectOption("2027-03-13");
  await list.getByRole("button", { name: "Preview" }).click();
  await expect(list.getByRole("status")).toContainText("runs 09:00 to 17:00");
  await list.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("region", { name: "Unscheduled (1)" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(`^${first} Tune the backline`) }),
  ).toBeVisible();

  // Undo returns it to the list.
  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByRole("region", { name: "Unscheduled (2)" })).toBeVisible();

  // Pointer: drag the second record onto the timeline's second day, then apply the preview.
  const item = page.getByRole("listitem").filter({ hasText: `${second} Label the cables` });
  await item.dragTo(page.locator("[data-day-drop]"), { targetPosition: { x: 40, y: 10 } });
  const placing = page.getByRole("group", { name: `Schedule ${second} Label the cables` });
  await expect(placing.getByRole("status")).toContainText("runs 09:00 to 17:00");
  await placing.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("region", { name: "Unscheduled (1)" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(`^${second} Label the cables`) }),
  ).toBeVisible();
});
