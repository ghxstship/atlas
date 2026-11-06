import { expect as baseExpect, settle, test } from "./engine-test";
import { expectAccessible, uniqueId } from "./support";
import { DEMO_ORG, signInAs } from "./a36-support";
import { createProject, createTask, newOwnerOrg } from "./b4-support";
import { uploadAttachment } from "./attachment-support";
import { expectCalmScreen } from "./b14-support";

/**
 * B14 file review (RRR-238; G-268): a file attached to a record shows its versions with their review state; the person
 * who uploaded a version is told someone else reviews it, so their own version offers no Approve. Someone else reviews
 * a record's two files on arrival, and the page keeps one primary action.
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

test("someone else reviews a record's two files, and the page keeps one primary action", async ({
  browser,
}) => {
  test.setTimeout(8 * 60_000);
  const title = `Draw the rigging plot ${uniqueId()}`;
  const owner = await (await browser.newContext()).newPage();
  await signInAs(owner, "owner@example.com", DEMO_ORG);
  await owner.goto(`/${DEMO_ORG}/work/all-records?create=1`);
  const create = owner.getByRole("dialog", { name: "New record" });
  await expect(create).toBeVisible();
  await create.getByLabel("Kind", { exact: true }).selectOption("Task");
  await create.getByLabel("Subtype").selectOption("Execute");
  await create.getByLabel("Title", { exact: true }).fill(title);
  await create.getByLabel("Project").selectOption({ label: "NWS · Northwind Summer Series" });
  await create.getByRole("button", { name: "Create record" }).click();
  await owner.waitForURL(/peek=/);
  const key = new URL(owner.url()).searchParams.get("peek") ?? "";
  await owner.goto(`/${DEMO_ORG}/r/${key}`);
  await settle(owner);
  for (const name of ["rigging-plot.pdf", "truss-plan.pdf"]) {
    await uploadAttachment(
      owner,
      { name, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4 ${name}`) },
      "e2e-b14-file-review",
    );
  }
  await owner.context().close();

  const admin = await (await browser.newContext()).newPage();
  await signInAs(admin, "admin@example.com", DEMO_ORG);
  await admin.goto(`/${DEMO_ORG}/r/${key}`);
  const reviews = admin
    .locator("section")
    .filter({ has: admin.getByRole("heading", { name: "File reviews" }) });
  await expect(reviews.getByRole("button", { name: "Approve", exact: true })).toHaveCount(2);
  await expectCalmScreen(admin);
  await expectAccessible(admin);
  // The control renders on arrival, so a retry only covers a click that came before hydration.
  await expect(async () => {
    await reviews.getByRole("button", { name: "Approve", exact: true }).first().click();
    await expect(reviews.getByText("Approved", { exact: true }).first()).toBeVisible({
      timeout: 5_000,
    });
  }).toPass();
  await admin.context().close();
});
