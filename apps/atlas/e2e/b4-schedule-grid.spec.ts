import { expect as baseExpect, test } from "./engine-test";
import { expectAccessible } from "./support";
import { createProject, newOwnerOrg } from "./b4-support";

/**
 * B4 (RRR-228, G-41): the day grid. Rows typed with Tab and Enter, times as shorthand on the project's clock, a
 * preview of what would change, refusals in place with nothing written, then Apply. The grid passes axe.
 */

test.use({ reducedMotion: "reduce" });
const expect = baseExpect.configure({ timeout: 20_000 });

test("journey: type a day's records into the grid, see a refusal in place, then apply", async ({
  page,
}) => {
  const slug = await newOwnerOrg(page, "b4g", "Gabe Gridder");
  await createProject(page, slug, {
    key: "GRD",
    name: "Grid Night",
    from: "2027-11-12",
    to: "2027-11-14",
  });

  await page.goto(`/${slug}/schedule/days?grid=GRD:2027-11-13`);
  const drawer = page.getByRole("dialog", { name: "GRD · 2027-11-13 as a grid" });
  await expect(drawer).toBeVisible();
  const grid = drawer.getByRole("grid", { name: "Records on 2027-11-13" });
  // The append row: Time, Title, Kind, by typing, Tab and Enter.
  await grid.getByRole("gridcell").first().click();
  await page.keyboard.type("8a-10:30a");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Installing the truss");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Task");
  await page.keyboard.press("Enter");
  await expect(grid).toContainText("08:00");

  // The title breaks the Task grammar: the refusal shows on its cell and nothing is written.
  await drawer.getByRole("button", { name: "Save" }).click();
  await expect(drawer.getByRole("status").first()).toContainText("1 refused");
  await expect(drawer).toContainText("imperative verb");
  await expectAccessible(page);

  // Fixed, the preview lists one new record, and Apply writes it.
  await grid.getByRole("gridcell", { name: /Installing the truss/ }).dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Hang the truss");
  await page.keyboard.press("Enter");
  await drawer.getByRole("button", { name: "Save" }).click();
  await expect(drawer.getByRole("status").first()).toContainText("1 new");
  await drawer.getByRole("button", { name: "Apply" }).click();
  await expect(drawer).toBeHidden();
  await page.goto(`/${slug}/work/all-records?q=truss`);
  await expect(page.getByText("Hang the truss").first()).toBeVisible();
});
