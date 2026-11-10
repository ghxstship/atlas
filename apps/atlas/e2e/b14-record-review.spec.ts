import type { Locator, Page } from "@playwright/test";
import { expect as baseExpect, settle, test } from "./engine-test";
import { expectAccessible, uniqueId } from "./support";
import { expectCalmScreen, whenHydrated } from "./b14-support";
import { createProject, createTask, newOwnerOrg } from "./b4-support";
import { DEMO_ORG, reloadUntil, signInAs } from "./a36-support";

/**
 * B14 record reviews (RRR-238; G-268, acceptance 19 to 23): a task that requires review is not Complete without an
 * approved review.
 *   * Alone in a new org, the owner turns Requires review on and starts the task; a review always names someone else
 *     as reviewer, so the panel says nobody else can review it instead of offering Ask for review, and the record
 *     cannot be completed (record_review_required).
 *   * On the demo tenant, the Owner asks the Admin for a review. The asker is offered no decision. The Admin asks for
 *     changes from Inbox, which needs a reason, and the task goes back to Active; asked again, the Admin approves on
 *     the record's Review panel, and the Owner completes the task.
 */

test.use({ reducedMotion: "reduce" });
const expect = baseExpect.configure({ timeout: 20_000 });

function reviewPanel(page: Page): Locator {
  // The panel is a section named by its heading, so it is a region of that name.
  return page.getByRole("region", { name: "Review", exact: true });
}

/** Moves the open record through its transition sheet with a reason. */
async function move(page: Page, next: string, reason: string): Promise<Locator> {
  await page.getByRole("button", { name: next, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: new RegExp(`to ${next}$`) });
  await sheet.getByLabel("Reason", { exact: true }).fill(reason);
  await sheet.getByRole("button", { name: "Move record" }).click();
  return sheet;
}

/** The switch shows what the server saved, so it turns on after the action and its refresh, never at the click. */
async function requireReview(review: Locator): Promise<void> {
  const toggle = review.getByRole("switch", { name: "Requires review", exact: true });
  await whenHydrated(toggle);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
}

async function askForReview(review: Locator, note: string): Promise<void> {
  const reviewer = review.getByLabel("Reviewer", { exact: true });
  await expect(reviewer).toBeVisible();
  await whenHydrated(reviewer);
  await reviewer.selectOption({ label: "Demo Admin" });
  await review.getByLabel("Note for the reviewer", { exact: true }).fill(note);
  await review.getByRole("button", { name: "Ask for review" }).click();
  // The first tag is the latest review's; the history, when there is one, repeats it.
  await expect(review.getByText("Review open", { exact: true }).first()).toBeVisible();
}

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
  const review = reviewPanel(page);
  await requireReview(review);
  await expectAccessible(page);

  // Start the work.
  for (const next of ["Ready", "Active"]) {
    await expect(await move(page, next, "Moving on.")).toBeHidden();
  }
  // Nobody else may review it, so no review can be asked for, and the record waits for one.
  await expect(
    review.getByText("Nobody else here can review this record yet.", { exact: false }),
  ).toBeVisible();
  await expect(review.getByRole("button", { name: "Ask for review" })).toHaveCount(0);
  const sheet = await move(page, "Complete", "Done.");
  await expect(
    sheet.getByText("This record needs an approved review before it is Complete."),
  ).toBeVisible();
});

test("a reviewer asks for changes from Inbox, then approves, and the owner completes the task", async ({
  browser,
}) => {
  test.setTimeout(8 * 60_000);
  const title = `Rig the follow spots ${uniqueId()}`;

  const owner = await (await browser.newContext()).newPage();
  await signInAs(owner, "owner@example.com", DEMO_ORG);
  await owner.goto(`/${DEMO_ORG}/work/all-records?create=1`);
  const create = owner.getByRole("dialog", { name: "New record" });
  await expect(create).toBeVisible();
  await create.getByLabel("Kind", { exact: true }).selectOption("Task");
  await create.getByLabel("Subtype").selectOption("Execute");
  await create.getByLabel("Title", { exact: true }).fill(title);
  await create.getByLabel("Project").selectOption({ label: "NWS · Northwind Summer Series" });
  await create.getByLabel("Due", { exact: true }).fill("2027-05-01T18:00");
  await create.getByRole("button", { name: "Create record" }).click();
  await owner.waitForURL(/peek=/);
  const key = new URL(owner.url()).searchParams.get("peek") ?? "";

  await owner.goto(`/${DEMO_ORG}/r/${key}`);
  await settle(owner);
  const review = reviewPanel(owner);
  await requireReview(review);
  for (const next of ["Ready", "Active"]) {
    await expect(await move(owner, next, "Moving on.")).toBeHidden();
  }

  // The Owner asks the Admin, and is offered no decision on their own request.
  await askForReview(review, "Check the focus positions.");
  await expect(review.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(review.getByRole("button", { name: "Request changes" })).toHaveCount(0);
  await expectAccessible(owner);

  // The Admin rejects from Inbox, which needs a reason.
  const admin = await (await browser.newContext()).newPage();
  await signInAs(admin, "admin@example.com", DEMO_ORG);
  await admin.goto(`/${DEMO_ORG}/inbox`);
  const item = admin.locator("article", { hasText: `Approval requested: ${title}` });
  await reloadUntil(admin, item);
  await item.getByRole("button", { name: "Reject", exact: true }).click();
  const reject = admin.getByRole("dialog", { name: "Reject with a reason" });
  await reject.getByLabel("Reason", { exact: true }).fill("Re-aim spot two at the lectern.");
  await reject.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(reject).toBeHidden();

  // The task is back to Active with the change asked for, and is asked again.
  await owner.reload();
  await settle(owner);
  await expect(review.getByText("Changes requested", { exact: true })).toBeVisible();
  await askForReview(review, "Re-aimed.");

  // The Admin approves on the record's Review panel.
  await admin.goto(`/${DEMO_ORG}/r/${key}`);
  await settle(admin);
  const decide = reviewPanel(admin);
  await expect(decide.getByRole("button", { name: "Request changes" })).toBeVisible();
  await expectAccessible(admin);
  await expectCalmScreen(admin);
  await decide.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(decide.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expect(decide.getByText("Decided by Demo Admin")).toBeVisible();
  await decide.getByText("2 reviews").click();
  await expect(decide.getByRole("listitem")).toHaveCount(2);

  // The Owner completes it.
  await owner.reload();
  await settle(owner);
  await expect(await move(owner, "Complete", "Done.")).toBeHidden();
  await expect(owner.getByText("Complete", { exact: true }).first()).toBeVisible();

  await admin.context().close();
  await owner.context().close();
});
