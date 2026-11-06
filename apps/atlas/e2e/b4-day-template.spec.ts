import { expect as baseExpect, test } from "./engine-test";
import { expectAccessible } from "./support";
import { addDay, createProject, createTask, newOwnerOrg } from "./b4-support";

/**
 * B4 (RRR-228, G-42): day templates. A day is saved as a template with its times from local midnight, listed on
 * Projects, Templates, and laid onto another day through a dry run that tags new items and those already there. Apply
 * adds exactly the ticked items. Each page passes axe.
 */

test.use({ reducedMotion: "reduce" });
const expect = baseExpect.configure({ timeout: 20_000 });

test("journey: save a show day as a template and lay it onto the next day", async ({ page }) => {
  const slug = await newOwnerOrg(page, "b4t", "Toni Template");
  await createProject(page, slug, {
    key: "TPL",
    name: "Template Tour",
    from: "2027-11-12",
    to: "2027-11-15",
  });
  await addDay(page, slug, "2027-11-13", "Show");
  await createTask(page, slug, "Rig the follow spots", "2027-11-13T10:00");

  await page.goto(`/${slug}/schedule/days?save=TPL:2027-11-13`);
  const save = page.getByRole("dialog", { name: "Save TPL · 2027-11-13 as a template" });
  await save.getByLabel("Template name").fill("Show Day");
  await save.getByRole("button", { name: "Save template" }).click();
  await expect(save).toBeHidden();

  await page.goto(`/${slug}/projects/templates`);
  await expect(page.getByRole("list", { name: "Day templates" })).toContainText("Show Day");
  await expectAccessible(page);

  // The dry run on the next day proposes the task as New.
  await page.goto(`/${slug}/schedule/days?apply=TPL:2027-11-14`);
  const apply = page.getByRole("dialog", { name: "Apply a template to TPL · 2027-11-14" });
  await expect(apply.getByText("New").first()).toBeVisible();
  await expect(apply.getByRole("checkbox", { name: "Rig the follow spots" })).toBeChecked();
  await expectAccessible(page);
  await apply.getByRole("button", { name: "Add 1 item" }).click();
  await expect(apply).toBeHidden();

  // A second dry run finds it already on the day, unticked.
  await page.goto(`/${slug}/schedule/days?apply=TPL:2027-11-14`);
  const again = page.getByRole("dialog", { name: "Apply a template to TPL · 2027-11-14" });
  await expect(again.getByText("Already on this day")).toBeVisible();
  await expect(again.getByRole("checkbox", { name: "Rig the follow spots" })).not.toBeChecked();
});
