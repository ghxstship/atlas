import { expect as baseExpect, settle, test } from "./engine-test";
import { expectAccessible } from "./support";
import { createProject, createTask, newOwnerOrg } from "./b4-support";

/**
 * B14 record reviews (RRR-238; G-268): a task that requires review is not Complete without an approved review. The
 * owner turns Requires review on, starts the task and asks for a review; with nobody else in the org the owner cannot
 * decide their own review (sod_approval_requester), and the record cannot be completed while the review is open.
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

  // Start the work, then ask for a review.
  for (const next of ["Ready", "Active"]) {
    await page.getByRole("button", { name: next, exact: true }).click();
    const sheet = page.getByRole("dialog", { name: new RegExp(`to ${next}$`) });
    await sheet.getByLabel("Reason").fill("Moving on.");
    await sheet.getByRole("button", { name: "Move record" }).click();
    await expect(sheet).toBeHidden();
  }
  await review.getByLabel("Note for the reviewer").fill("Check the focus positions.");
  await review.getByRole("button", { name: "Request review" }).click();
  await expect(review.getByText("Review open")).toBeVisible();
  await expect(page.getByText("In Review").first()).toBeVisible();

  // The requester never decides their own review, and the record waits for it.
  await expect(review.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: /to Complete$/ });
  await sheet.getByLabel("Reason").fill("Done.");
  await sheet.getByRole("button", { name: "Move record" }).click();
  await expect(sheet.getByText("The review is still open.")).toBeVisible();
});
