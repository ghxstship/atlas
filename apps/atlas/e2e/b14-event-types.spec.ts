import { expect as baseExpect, settle, test } from "./engine-test";
import { expectAccessible } from "./support";
import {
  addDocumentType,
  addEventType,
  addProjectField,
  clearGate,
  expectCalmScreen,
  newOwnerOrg,
  openEventType,
} from "./b14-support";

/**
 * B14 event types and setup completeness (RRR-238; G-250, G-266): an Owner configures a Music Festival type with a
 * required detail and a Required document type in Settings, Templates; New project walks the staged intake by keyboard,
 * the Details step refuses to go on without the required detail, and the project carries its type; gate 1 is refused
 * until a typed document with a version is on file, then passes. A refused save returns to the step that holds the
 * dates with every answer kept. An org with no event types and no project fields keeps the single screen, with a way to
 * the staged steps, and project fields take their own Details step; nine fields page at seven and no step shows more.
 * Each run signs up a new owner in a new org.
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
  const next = () => dialog.getByRole("button", { name: "Next" }).press("Enter");
  await expect(dialog.getByRole("heading", { name: "Start" })).toBeVisible();
  await expect(dialog.getByText("Step 1 of 5, Start")).toBeAttached();
  await expectAccessible(page);
  await expectCalmScreen(page);
  // Space picks a radio and Enter presses a button: the walk needs no pointer.
  await dialog.getByLabel("Music Festival").press("Space");
  await expect(dialog.getByLabel("Music Festival")).toBeChecked();
  await next();
  await expect(dialog.getByRole("heading", { name: "Scale and audience" })).toBeFocused();
  await expect(dialog.getByText("Step 2 of 6, Scale and audience")).toBeAttached();
  await dialog.getByLabel("Large, 10,000 to 50,000 people").press("Space");
  await expect(dialog.getByLabel("Large, 10,000 to 50,000 people")).toBeChecked();
  await next();
  await expect(dialog.getByRole("heading", { name: "Basics" })).toBeFocused();
  await expectCalmScreen(page);
  await dialog.getByLabel("Project key").fill("MFE");
  await dialog.getByLabel("Project name").fill("Music Festival Edition");
  await dialog.getByLabel("First production day").fill("2027-06-10");
  await dialog.getByLabel("Last production day").fill("2027-06-12");
  await next();
  await expect(dialog.getByRole("heading", { name: "Load-in and load-out" })).toBeFocused();
  await expectCalmScreen(page);
  // A last load-in day after the first show day, which the save refuses.
  await dialog.getByLabel("First load-in day").fill("2027-06-09");
  await dialog.getByLabel("Last load-in day").fill("2027-06-11");
  await next();
  await expect(dialog.getByRole("heading", { name: "Details" })).toBeFocused();
  await expect(
    dialog.getByText("Have the site plan and the licensed capacity ready."),
  ).toBeVisible();
  await settle(page);
  await next();
  await expect(dialog.getByRole("heading", { name: "Details" })).toBeVisible();
  await dialog.getByLabel(/Licensed capacity/).fill("12000");
  await next();
  await expect(dialog.getByRole("heading", { name: "Review" })).toBeFocused();
  // Exact: the Details step's hidden guidance also says "site plan".
  await expect(dialog.getByText("Site Plan", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Create project" }).press("Enter");

  // Refused: back on the step that holds the dates, with every answer still there.
  await expect(dialog.getByRole("heading", { name: "Load-in and load-out" })).toBeFocused();
  await expect(
    dialog.getByText("Load-in ends on or before the first show day", { exact: false }).first(),
  ).toBeVisible();
  await expect(dialog.getByLabel("First load-in day")).toHaveValue("2027-06-09");
  await expect(dialog.getByLabel("Last load-in day")).toHaveValue("2027-06-11");
  await dialog.getByLabel("Last load-in day").fill("2027-06-10");
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(dialog.getByLabel("Project key")).toHaveValue("MFE");
  await expect(dialog.getByLabel("Project name")).toHaveValue("Music Festival Edition");
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(dialog.getByLabel("Large, 10,000 to 50,000 people")).toBeChecked();
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(dialog.getByLabel("Music Festival")).toBeChecked();
  for (const heading of [
    "Scale and audience",
    "Basics",
    "Load-in and load-out",
    "Details",
    "Review",
  ]) {
    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog.getByRole("heading", { name: heading })).toBeFocused();
  }
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/MFE/overview`);
  await expect(page.getByText("Music Festival").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();

  // The type and bands save on their own, and General keeps seven fields and the one primary action.
  await page.goto(`/${slug}/p/MFE/settings`);
  await settle(page);
  await expectCalmScreen(page);
  const typing = page.getByRole("region", { name: "Event type", exact: true });
  await typing.getByLabel("Scale", { exact: true }).selectOption("Major");
  await typing.getByRole("button", { name: "Save event type" }).click();
  await expect(typing.getByRole("status")).toBeVisible();
  await expect(typing.getByLabel("Scale", { exact: true })).toHaveValue("Major");

  // Gate 1 waits for the Site Plan.
  await page.goto(`/${slug}/p/MFE/gates`);
  await clearGate(page, 1);
  await expect(page.getByText("Required documents and details")).toBeVisible();
  await page.getByRole("button", { name: /^Pass gate 1/ }).click();
  const pass = page.getByRole("dialog");
  await pass.getByLabel("Decision", { exact: true }).fill("Go.");
  await pass.getByRole("button", { name: "Pass gate" }).click();
  await expect(
    pass.getByText(/Gate 1 needs the required documents first\. Missing: Site Plan\./),
  ).toBeVisible();
  await pass.getByRole("button", { name: "Cancel" }).click();

  await page.goto(`/${slug}/p/MFE/documents`);
  await page.getByRole("link", { name: "Add Site Plan" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByLabel("Type", { exact: true })).toHaveValue(/.+/);
  await drawer.getByLabel("Title", { exact: true }).fill("Main site plan");
  await drawer.getByLabel("File location").fill("https://docs.example.com/site-plan.pdf");
  await drawer.getByLabel("File to fingerprint").setInputFiles({
    name: "site-plan.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 site plan"),
  });
  await drawer.getByRole("button", { name: "Add document" }).click();
  await page.goto(`/${slug}/p/MFE/gates`);
  await page.getByRole("button", { name: "Pass gate 1" }).click();
  const again = page.getByRole("dialog");
  await again.getByLabel("Decision", { exact: true }).fill("Go decision recorded.");
  await again.getByRole("button", { name: "Pass gate" }).click();
  await expect(again).toBeHidden();
  await expect(page.getByText("Gate 2").first()).toBeVisible();
});

test("an org without event types keeps the single screen and reaches the staged steps by a button", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  const slug = await newOwnerOrg(page, "b14s", "Sam Single");
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  const other = dialog.getByRole("button", { name: "Start from a template or a past project" });
  await expect(other).toBeVisible();
  await expect(dialog.getByLabel("Project key")).toBeVisible();
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await expectCalmScreen(page);

  await other.click();
  await expect(dialog.getByRole("heading", { name: "Start" })).toBeFocused();
  await expect(dialog.getByLabel("Leave out the template's dates")).toBeVisible();
  await expect(dialog.getByText("Event type", { exact: true })).toHaveCount(0);
  await expectCalmScreen(page);
  await expectAccessible(page);

  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(other).toBeVisible();
  await expect(dialog.getByLabel("Project key")).toBeVisible();
});

test("nine fields page at seven, and an empty required field on the next page takes focus", async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const slug = await newOwnerOrg(page, "b14n", "Nina Nine");
  const labels = Array.from({ length: 9 }, (_, i) => `Detail ${String(i + 1)}`);
  for (const label of labels) await addProjectField(page, slug, label, "Number");

  // Project fields with no event type: Start, Basics, Load-in and load-out, Details and Review, none over seven.
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const plain = page.getByRole("dialog", { name: "New project" });
  await expect(plain.getByText("Step 1 of 5, Start")).toBeAttached();
  await expect(plain.getByRole("button", { name: "Back" })).toHaveCount(0);
  for (const heading of ["Basics", "Load-in and load-out"]) {
    await plain.getByRole("button", { name: "Next" }).click();
    await expect(plain.getByRole("heading", { name: heading })).toBeFocused();
    await expectCalmScreen(page);
    if (heading === "Basics") {
      await plain.getByLabel("Project key").fill("NNE");
      await plain.getByLabel("Project name").fill("Nine Fields Edition");
    }
  }
  await plain.getByRole("button", { name: "Next" }).click();
  await expect(plain.getByRole("heading", { name: "Details" })).toBeFocused();
  await settle(page);
  await expect(plain.getByLabel("Detail 7", { exact: true })).toBeVisible();
  await expect(plain.getByLabel("Detail 8", { exact: true })).toBeHidden();
  await expectCalmScreen(page);

  // A type that requires eight of them: the seven on the first page are filled, and Next finds the eighth empty.
  await addEventType(page, slug, "Trade Show");
  const row = await openEventType(page, slug, "Trade Show");
  const add = row.getByRole("form", { name: "Add detail" });
  for (const [i, label] of labels.entries()) {
    await add.getByLabel("Project field").selectOption({ label });
    if (i < 8) await add.getByLabel("Required for this type").check();
    await add.getByRole("button", { name: "Add detail" }).click();
    await expect(row.getByText(new RegExp(`^${label},`))).toBeVisible();
  }

  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Trade Show").check();
  await dialog.getByRole("button", { name: "Next" }).click();
  await dialog.getByRole("button", { name: "Next" }).click();
  await dialog.getByLabel("Project key").fill("TSE");
  await dialog.getByLabel("Project name").fill("Trade Show Edition");
  await dialog.getByRole("button", { name: "Next" }).click();
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByRole("heading", { name: "Details" })).toBeFocused();
  await settle(page);
  await expectCalmScreen(page);
  for (const label of labels.slice(0, 7)) {
    await dialog.getByLabel(label, { exact: false }).fill("1");
  }
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByRole("heading", { name: "Details, continued" })).toBeVisible();
  await expect(dialog.getByLabel("Detail 8", { exact: false })).toBeFocused();
  await expect(dialog.getByLabel("Detail 1", { exact: false })).toBeHidden();
  await expectCalmScreen(page);
  await dialog.getByLabel("Detail 8", { exact: false }).fill("8");
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByRole("heading", { name: "Review" })).toBeFocused();
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/TSE/overview`);
});
