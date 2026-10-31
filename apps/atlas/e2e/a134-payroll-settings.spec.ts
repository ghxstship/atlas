import { expect as baseExpect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A134 (RRR-196, ADR 0112): Settings, Payroll and Time Off edits earning codes, time off policies and holiday
 * calendars. An Owner adds a policy and edits it, adds an earning code, requests five days off in Crew, Time Off
 * under the edited policy, then adds a holiday on the org calendar inside the request: the request counts four days
 * off. Each run signs up a new Owner in a new org, so runs never collide on the shared stack.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("a policy edit and a holiday change a time off request's day count", async ({ page }) => {
  const id = uniqueId();
  const slug = `holidays-${id}`;
  await signUp(page, { name: "Hana Holidays", email: testEmail("holidays", id) });
  await createOrganization(page, { name: `Holidays ${id}`, slug });

  // A policy, then an edit of it.
  await page.goto(`/${slug}/settings/payroll-and-time-off`);
  const addPolicy = page.getByRole("form", { name: "Add a time off policy" });
  await addPolicy.getByLabel("Policy name").fill("Paid Time Off");
  await addPolicy.getByLabel("Hours accrued per pay period").fill("4");
  await addPolicy.getByRole("button", { name: "Add policy" }).click();
  const policies = page.getByRole("list", { name: "Time off policies" });
  await expect(policies).toContainText("Paid Time Off");
  await expect(policies).toContainText("4 h per pay period");

  await policies.getByText("Edit Paid Time Off").click();
  const editPolicy = page.getByRole("form", { name: "Edit Paid Time Off" });
  await editPolicy.getByLabel("Policy name").fill("Vacation");
  await editPolicy.getByLabel("Hours accrued per pay period").fill("6");
  await editPolicy.getByRole("button", { name: "Save" }).click();
  await expect(policies).toContainText("Vacation");
  await expect(policies).toContainText("6 h per pay period");
  await expect(policies).not.toContainText("Paid Time Off");

  // A holiday earning code: its kind is shown beside it.
  const addCode = page.getByRole("form", { name: "Add an earning code" });
  await addCode.getByLabel("Code", { exact: true }).fill("hol");
  await addCode.getByLabel("Name", { exact: true }).fill("Holiday");
  await addCode.getByLabel("Pays").selectOption("holiday");
  await addCode.getByRole("button", { name: "Add earning code" }).click();
  const codes = page.getByRole("list", { name: "Earning codes" });
  await expect(codes).toContainText("HOL · Holiday");
  await expect(codes).toContainText("Holiday pay");

  // The org calendar, still without holidays.
  const addCalendar = page.getByRole("form", { name: "Add a holiday calendar" });
  await addCalendar.getByLabel("Calendar name").fill("United States");
  await addCalendar.getByLabel("Applies across the org").check();
  await addCalendar.getByRole("button", { name: "Add calendar" }).click();
  const calendars = page.getByRole("list", { name: "Holiday calendars" });
  await expect(calendars).toContainText("Applies across the org.");
  await expectAccessible(page);

  // Five days off, Friday to Tuesday, under the edited policy.
  await page.goto(`/${slug}/crew/time-off?create=1`);
  const drawer = page.getByRole("dialog", { name: "Request time off" });
  await drawer.getByLabel("Policy").selectOption({ label: "Vacation" });
  await drawer.getByLabel("First day off").fill("2027-07-02");
  await drawer.getByLabel("Last day off").fill("2027-07-06");
  await drawer.getByLabel("Hours requested").fill("32");
  await drawer.getByRole("button", { name: "Request time off" }).click();
  await expect(drawer).toBeHidden();
  await page.goto(`/${slug}/crew/time-off?view=list`);
  const requests = page.getByRole("list", { name: "Time off requests" });
  await expect(requests).toContainText("Vacation");
  await expect(requests).toContainText("5 days off");

  // Independence Day observed on Monday takes a day out of the request.
  await page.goto(`/${slug}/settings/payroll-and-time-off`);
  const addHoliday = page.getByRole("form", { name: "Add a holiday to United States" });
  await addHoliday.getByLabel("Date").fill("2027-07-05");
  await addHoliday.getByLabel("Holiday name").fill("Independence Day (observed)");
  await addHoliday.getByRole("button", { name: "Add holiday" }).click();
  await expect(page.getByRole("list", { name: "Holidays on United States" })).toContainText(
    "Independence Day (observed)",
  );
  await expectAccessible(page);

  await page.goto(`/${slug}/crew/time-off?view=list`);
  await expect(requests).toContainText("4 days off");
  await expectAccessible(page);
});
