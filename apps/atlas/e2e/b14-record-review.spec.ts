import { expect as baseExpect, settle, test } from "./engine-test";
import { expectAccessible } from "./support";
import { createProject, createTask, newOwnerOrg } from "./b4-support";

/**
 * B14 record reviews (RRR-238; G-268): a task that requires review is not Complete without an approved review. The
 * owner turns Requires review on and starts the task; a review always names someone else as reviewer, so with nobody
 * else in the org the panel says so instead of offering Ask for review, and the record cannot be completed without
 * an approved review (record_review_required).
 */

test.use({ reducedMotion: "reduce" });
const expect = baseExpect.configure({ timeout: 20_000 });

test("a task that requires review waits for an approved review", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const slug = await newOwnerOrg(page, "b14r", "Riley Review");
  await createProject(page, slug, {
    key: "RVW",
    name: "Review Edition",
    from: "2027-05-01",
    to: "2027-05-02",
  });
  const key = await createTask(page, slug, "Rig the follow spots", "2027-05-01T18:00");
  await page.goto(`/${slug}/r/${key}`);
  await settle(page);
  const review = page.locator("section", {
    has: page.getByRole("heading", { name: "Review", exact: true }),
  });
  await review.getByLabel("Requires review").check();
  await expect(review.getByLabel("Requires review")).toBeChecked();
  await expectAccessible(page);

  // Start the work.
  for (const next of ["Ready", "Active"]) {
    await page.getByRole("button", { name: next, exact: true }).click();
    const sheet = page.getByRole("dialog", { name: new RegExp(`to ${next}$`) });
    await sheet.getByLabel("Reason").fill("Moving on.");
    await sheet.getByRole("button", { name: "Move record" }).click();
    await expect(sheet).toBeHidden();
  }
  // Nobody else may review it, so no review can be asked for, and the record waits for one.
  await expect(
    review.getByText("Nobody else here can review this record yet.", { exact: false }),
  ).toBeVisible();
  await expect(review.getByRole("button", { name: "Ask for review" })).toHaveCount(0);
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: /to Complete$/ });
  await sheet.getByLabel("Reason").fill("Done.");
  await sheet.getByRole("button", { name: "Move record" }).click();
  await expect(
    sheet.getByText("This record needs an approved review before it is Complete."),
  ).toBeVisible();
});
