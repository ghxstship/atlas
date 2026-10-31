import { expect as baseExpect, test } from "./engine-test";
import { expectAccessible } from "./support";
import { addDay, createProject, createTask, newOwnerOrg } from "./b4-support";

/**
 * B4 (RRR-228, G-38): day types. A planner marks a Load In, a Show and a day split into a Load Out and Travel to
 * another time zone; four parts are the most a day takes. The days read as text on Schedule, Days, its calendar, the
 * project timeline's table and the portfolio timeline. Each page passes axe.
 */

test.use({ reducedMotion: "reduce" });
const expect = baseExpect.configure({ timeout: 20_000 });

test("journey: mark load-in, show and a split load-out day, and see them across schedules", async ({
  page,
}) => {
  const slug = await newOwnerOrg(page, "b4d", "Dana Planner");
  await createProject(page, slug, {
    key: "DTY",
    name: "Day Type Tour",
    from: "2027-11-11",
    to: "2027-11-15",
  });
  await addDay(page, slug, "2027-11-12", "Load In");
  await addDay(page, slug, "2027-11-13", "Show");

  // A split day: a load-out, then travel to Austin in the Central zone.
  await page.goto(`/${slug}/schedule/days`);
  await page.getByRole("button", { name: "Add day" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Add a day" });
  await drawer.getByLabel("Date").fill("2027-11-14");
  await drawer.getByLabel("Day type").first().selectOption("Load Out");
  await drawer.getByRole("button", { name: "Split day" }).click();
  const second = drawer.getByRole("listitem").filter({ hasText: "Part 2" });
  await second.getByLabel("Day type").selectOption("Travel");
  await second.getByLabel("Label").fill("Travel to Austin");
  await second.getByLabel("Place", { exact: true }).fill("Austin, Texas");
  await second.getByLabel("Time zone").selectOption("America/Chicago");
  // Four parts at most: Split day is off once four are there.
  await drawer.getByRole("button", { name: "Split day" }).click();
  await drawer.getByRole("button", { name: "Split day" }).click();
  await expect(drawer.getByRole("button", { name: "Split day" })).toBeDisabled();
  await expect(drawer.getByText("A day splits into at most four parts.")).toBeVisible();
  await drawer.getByRole("button", { name: "Remove part 4" }).click();
  await drawer.getByRole("button", { name: "Remove part 3" }).click();
  await drawer.getByRole("button", { name: "Save day" }).click();
  await expect(drawer).toBeHidden();

  const table = page.getByRole("table", { name: "Day types" });
  for (const text of ["Load In", "Show", "Load Out", "Travel to Austin", "America/Chicago"]) {
    await expect(table).toContainText(text);
  }
  await expectAccessible(page);

  // The calendar names each day's types as text.
  await page.goto(`/${slug}/schedule/days?view=calendar&month=2027-11-01`);
  await expect(page.getByRole("list", { name: "Day types" }).first()).toContainText("Load In");
  await expectAccessible(page);

  // The project timeline's table names the day type of each record's day.
  await createTask(page, slug, "Focus the lights", "2027-11-13T10:00");
  await page.goto(`/${slug}/p/DTY/schedule?view=timeline`);
  await expect(page.getByRole("table", { name: /Schedule/ })).toContainText("(Show)");
  await expectAccessible(page);
});
