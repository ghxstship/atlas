import { expect as baseExpect, settle, test } from "./engine-test";
import { expectAccessible } from "./support";
import { createProject, createTask, newOwnerOrg } from "./b4-support";
import { uploadAttachment } from "./attachment-support";

/**
 * B14 file review (RRR-238; G-268): a file attached to a record shows its versions with their review state; the person
 * who uploaded a version is told someone else reviews it, so their own version offers no Approve.
 */

test.use({ reducedMotion: "reduce" });
const expect = baseExpect.configure({ timeout: 20_000 });

test("a record's file lists its versions and is not reviewed by its uploader", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const slug = await newOwnerOrg(page, "b14f", "Frankie Files");
  await createProject(page, slug, {
    key: "FRV",
    name: "File Review Edition",
    from: "2027-05-01",
    to: "2027-05-02",
  });
  const key = await createTask(page, slug, "Draw the spot plot", "2027-05-01T18:00");
  await page.goto(`/${slug}/r/${key}`);
  await settle(page);
  await uploadAttachment(
    page,
    {
      name: "spot-plot.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 spot plot"),
    },
    "e2e-b14-file-review",
  );
  const reviews = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "File reviews" }) });
  await expect(reviews.getByText("spot-plot.pdf").first()).toBeVisible();
  await expect(reviews.getByText("Version 1")).toBeVisible();
  await expect(reviews.getByText("Not reviewed").first()).toBeVisible();
  await expect(
    reviews.getByText("You uploaded this version, so someone else reviews it."),
  ).toBeVisible();
  await expect(reviews.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expectAccessible(page);
});
