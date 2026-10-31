import { expect as baseExpect, settle, test } from "./engine-test";
import { expectAccessible } from "./support";
import {
  addDocumentType,
  addEventType,
  addProjectField,
  clearGate,
  newOwnerOrg,
  openEventType,
} from "./b14-support";

/**
 * B14 event types and setup completeness (RRR-238; G-250, G-266): an Owner configures a Music Festival type with a
 * required detail and a Required document type in Settings, Templates; New project walks the staged intake by keyboard,
 * the Details step refuses to go on without the required detail, and the project carries its type; gate 1 is refused
 * until a typed document with a version is on file, then passes. Each run signs up a new owner in a new org.
 */

test.use({ reducedMotion: "reduce" });
const expect = baseExpect.configure({ timeout: 20_000 });

test("an event type picks the intake's details and holds a gate until its documents are in", async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  const slug = await newOwnerOrg(page, "b14t", "Toni Types");
  await addProjectField(page, slug, "Licensed capacity", "Number");
  await addEventType(page, slug, "Music Festival");
  await addDocumentType(page, slug, "Site Plan");

  const row = await openEventType(page, slug, "Music Festival");
  const field = row.getByRole("form", { name: "Add detail" });
  await field.getByLabel("Project field").selectOption({ label: "Licensed capacity" });
  await field.getByLabel("Required for this type").check();
  await field.getByRole("button", { name: "Add detail" }).click();
  await expect(row.getByText(/Licensed capacity, required by Gate 1/)).toBeVisible();
  const requirement = row.getByRole("form", { name: "Add document" });
  await requirement.getByLabel("Document type").selectOption({ label: "Site Plan" });
  await requirement.getByLabel("Needed by").selectOption("1");
  await requirement.getByRole("button", { name: "Add document" }).click();
  await expect(row.getByText(/Site Plan, required by Gate 1/)).toBeVisible();
  await expectAccessible(page);

  // The staged intake, by keyboard.
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog.getByRole("heading", { name: "Start" })).toBeVisible();
  await expect(dialog.getByText("Step 1 of 4, Start")).toBeAttached();
  await expectAccessible(page);
  await dialog.getByLabel("Music Festival").check();
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByRole("heading", { name: "Scale and audience" })).toBeFocused();
  await expect(dialog.getByText("Step 2 of 5, Scale and audience")).toBeAttached();
  await dialog.getByLabel("Large, 10,000 to 50,000 people").check();
  await dialog.getByRole("button", { name: "Next" }).press("Enter");
  await expect(dialog.getByRole("heading", { name: "Basics" })).toBeFocused();
  await dialog.getByLabel("Project key").fill("MFE");
  await dialog.getByLabel("Project name").fill("Music Festival Edition");
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByRole("heading", { name: "Details" })).toBeFocused();
  await expect(
    dialog.getByText("Have the site plan and the licensed capacity ready."),
  ).toBeVisible();
  await settle(page);
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByRole("heading", { name: "Details" })).toBeVisible();
  await dialog.getByLabel(/Licensed capacity/).fill("12000");
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByRole("heading", { name: "Review" })).toBeFocused();
  await expect(dialog.getByText("Site Plan")).toBeVisible();
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/MFE/overview`);
  await expect(page.getByText("Music Festival").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();

  // Gate 1 waits for the Site Plan.
  await page.goto(`/${slug}/p/MFE/gates`);
  await clearGate(page, 1);
  await expect(page.getByText("Required documents and details")).toBeVisible();
  await page.getByRole("button", { name: /^Pass gate 1/ }).click();
  const pass = page.getByRole("dialog");
  await pass.getByLabel("Decision").fill("Go.");
  await pass.getByRole("button", { name: "Pass gate" }).click();
  await expect(
    pass.getByText(/Gate 1 needs the required documents first\. Missing: Site Plan\./),
  ).toBeVisible();
  await pass.getByRole("button", { name: "Cancel" }).click();

  await page.goto(`/${slug}/p/MFE/documents`);
  await page.getByRole("link", { name: "Add Site Plan" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByLabel("Type")).toHaveValue(/.+/);
  await drawer.getByLabel("Title").fill("Main site plan");
  await drawer.getByLabel("File location").fill("https://docs.example.com/site-plan.pdf");
  await drawer
    .getByLabel("File to fingerprint")
    .setInputFiles({
      name: "site-plan.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 site plan"),
    });
  await drawer.getByRole("button", { name: "Add document" }).click();
  await page.goto(`/${slug}/p/MFE/gates`);
  await page.getByRole("button", { name: "Pass gate 1" }).click();
  const again = page.getByRole("dialog");
  await again.getByLabel("Decision").fill("Go decision recorded.");
  await again.getByRole("button", { name: "Pass gate" }).click();
  await expect(again).toBeHidden();
  await expect(page.getByText("Gate 2").first()).toBeVisible();
});
