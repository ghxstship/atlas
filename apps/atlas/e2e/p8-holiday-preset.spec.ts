import { expect as baseExpect, test } from "./engine-test";
import { expectAccessible } from "./support";
import { newOwnerOrg } from "./p8-support";

/**
 * P8 (RRR-222, parity gap G-117; Section 4.5.6): the US federal preset and the worked-holiday multiplier in Settings,
 * Payroll and Time Off. Adding 2027's federal holidays adds eleven, a second run adds none, a multiplier outside 1 to
 * 3 is refused as invalid, and 1.5 is saved and shown.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("add the US federal holidays and set the worked-holiday multiplier", async ({ page }) => {
  const slug = await newOwnerOrg(page, "p8hol", "Hana Holidays");
  await page.goto(`/${slug}/settings/payroll-and-time-off`);
  const addCalendar = page.getByRole("form", { name: "Add a holiday calendar" });
  await addCalendar.getByLabel("Calendar name").fill("United States");
  await addCalendar.getByLabel("Applies across the org").check();
  await addCalendar.getByRole("button", { name: "Add calendar" }).click();
  const calendars = page.getByRole("list", { name: "Holiday calendars" });
  await expect(calendars).toContainText("Applies across the org.");

  const preset = page.getByRole("form", { name: "Add US federal holidays to United States" });
  await preset.getByLabel("Year").selectOption("2027");
  await preset.getByRole("button", { name: "Add US federal holidays" }).click();
  await expect(preset.getByText("11 added, 0 already on the calendar.")).toBeVisible();
  await expect(calendars).toContainText("Christmas Day");
  await expect(calendars).toContainText("Juneteenth National Independence Day");
  await preset.getByRole("button", { name: "Add US federal holidays" }).click();
  await expect(preset.getByText("0 added, 11 already on the calendar.")).toBeVisible();
  await expectAccessible(page);

  // The multiplier: 3.5 is outside 1 to 3, so the field is invalid and nothing is saved; 1.5 is saved.
  await calendars.getByText("Edit United States").click();
  const edit = page.getByRole("form", { name: "Edit United States" });
  const multiplier = edit.getByLabel("Worked holiday pay");
  await multiplier.fill("3.5");
  await edit.getByRole("button", { name: "Save" }).click();
  expect(await multiplier.evaluate((el) => (el as HTMLInputElement).validity.valid)).toBe(false);
  await multiplier.fill("1.5");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(calendars).toContainText("Work on a holiday pays 1.5x");
});
