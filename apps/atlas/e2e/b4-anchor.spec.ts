import { expect as baseExpect, test, type Page } from "./engine-test";
import { expectAccessible } from "./support";
import { createProject, createTask, newOwnerOrg } from "./b4-support";

/**
 * B4 (RRR-228, G-44): the anchor. Set anchor sets the first anchor day and moves nothing; Move anchor previews what
 * moves and what stays, Apply moves a dated record by whole days on the project's clock, and the timeline's table
 * reads each record's offset from the anchor. A record pinned to its dates stays. Each page passes axe.
 */

test.use({ reducedMotion: "reduce" });
const expect = baseExpect.configure({ timeout: 20_000 });

async function dueOf(page: Page, slug: string, key: string): Promise<string> {
  await page.goto(`/${slug}/r/${key}`);
  await page
    .getByRole("form", { name: "Edit record" })
    .getByRole("button", { name: "More fields" })
    .click();
  return page.getByLabel("Due", { exact: true }).inputValue();
}

test("journey: set and move a project's anchor, with a pinned record staying", async ({ page }) => {
  const slug = await newOwnerOrg(page, "b4a", "Avery Anchor");
  await createProject(page, slug, {
    key: "ANC",
    name: "Anchor Weekend",
    from: "2027-03-12",
    to: "2027-03-15",
  });
  const moving = await createTask(page, slug, "Hang the truss", "2027-03-12T10:00");
  const pinned = await createTask(page, slug, "File the noise permit", "2027-03-11T09:00");
  await page.goto(`/${slug}/r/${pinned}`);
  await page.getByLabel("Stays on its dates when the anchor moves").check();

  await page.goto(`/${slug}/p/ANC/schedule`);
  await expect(page.getByText("No anchor day set.")).toBeVisible();
  await page.getByRole("button", { name: "Set anchor" }).click();
  const set = page.getByRole("dialog", { name: "Set the anchor day of ANC" });
  await set.getByLabel("Anchor day").fill("2027-03-13");
  await set.getByRole("button", { name: "Set anchor" }).click();
  await expect(page.getByText(/Anchor: Saturday, March 13, 2027/)).toBeVisible();
  // Setting the first anchor moves nothing.
  expect(await dueOf(page, slug, moving)).toBe("2027-03-12T10:00");

  await page.goto(`/${slug}/p/ANC/schedule`);
  await page.getByRole("button", { name: "Move anchor" }).click();
  const move = page.getByRole("dialog", { name: "Move the anchor of ANC" });
  await move.getByLabel("Anchor day").fill("2027-03-15");
  await expect(move.getByText("2 days later")).toBeVisible();
  await move.getByRole("button", { name: "Preview" }).click();
  await expect(
    move.getByRole("region", { name: "Moves" }).or(move.getByText("Moves")),
  ).toBeVisible();
  await expect(move).toContainText("Pinned to its dates");
  await expectAccessible(page);
  await move.getByRole("button", { name: /^Move \d+ items?$/ }).click();
  await expect(move).toBeHidden();
  await expect(page.getByRole("button", { name: "Move back" })).toBeVisible();

  expect(await dueOf(page, slug, moving)).toBe("2027-03-14T10:00");
  expect(await dueOf(page, slug, pinned)).toBe("2027-03-11T09:00");

  // The timeline draws the anchor and its table reads each record's offset.
  await page.goto(`/${slug}/p/ANC/schedule?view=timeline`);
  const table = page.getByRole("table", { name: /Schedule/ });
  await expect(table.getByRole("columnheader", { name: "Offset" })).toBeAttached();
  await expect(table).toContainText("1 day before the anchor");
  await expectAccessible(page);
});
