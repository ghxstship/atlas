import { expect as baseExpect, test } from "./engine-test";
import { cognitiveLoadProblems } from "./a11y/checks";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

// Each save is a server action that renders Settings again; a dev server compiles it on first use.
const expect = baseExpect.configure({ timeout: 20_000 });

/**
 * Work Details in Atlas (A78, finding A65-003, migration 1340): a new member fills in Settings,
 * Work Details. An emergency contact typed in national format is stored in E.164 and shown back in
 * national format (Section 15); sizes and dietary needs save; the passport number shows only its
 * last four until the explicit reveal, which the access log records; the page stays axe clean and
 * within the cognitive load gate (one primary action, at most seven fields per form, gate 27).
 * Settings, Profile takes the optional given and family names.
 */
test("Work Details: a member records their details and reveals the passport number", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const id = uniqueId();
  const slug = `details-${id}`;
  await signUp(page, { name: "Wren Details", email: testEmail("details", id) });
  await createOrganization(page, { name: `Details ${id}`, slug });

  await page.goto(`/${slug}/me/work-details`);
  await expect(page.getByRole("heading", { name: "Emergency contacts" })).toBeVisible();
  await expect(page.getByText("No emergency contacts yet.")).toBeVisible();
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await expectAccessible(page);

  const add = page.getByRole("form", { name: "Add contact" });
  await add.getByLabel("Name").fill("Robin Example");
  await add.getByLabel("Relationship").fill("Partner");
  await add.getByLabel("Phone", { exact: true }).fill("not a number");
  await add.getByRole("button", { name: "Add contact" }).click();
  await expect(add.getByText(/Enter a phone number with its country code/)).toBeVisible();
  await add.getByLabel("Phone", { exact: true }).fill("(305) 555-0142");
  await add.getByRole("button", { name: "Add contact" }).click();
  const contact = page.getByRole("listitem").filter({ hasText: "Robin Example" });
  await expect(contact).toContainText("(305) 555-0142");

  const uniform = page.getByRole("form", { name: "Uniform sizes" });
  await uniform.getByLabel("Shirt").selectOption("M");
  await uniform.getByLabel("Shoes").fill("US 9");
  await uniform.getByRole("button", { name: "Save sizes" }).click();
  await expect(uniform.getByRole("status")).toHaveText("Saved.");

  const dietary = page.getByRole("form", { name: "Dietary needs" });
  await dietary.getByRole("button", { name: /^Dietary needs/ }).click();
  await dietary.getByLabel("Vegan").check();
  await dietary.getByLabel("Allergies").fill("Peanuts, anaphylaxis");
  await dietary.getByRole("button", { name: "Save dietary needs" }).click();
  await expect(dietary.getByRole("status")).toHaveText("Saved.");

  const passport = page.getByRole("form", { name: "Passport" });
  await passport.getByLabel("Passport number").fill("TEST-123456");
  await passport.getByRole("button", { name: "Save passport details" }).click();
  await expect(passport.getByRole("status")).toHaveText("Saved.");
  await page.reload();
  await expect(page.getByText("Number on file ending 3456")).toBeVisible();
  const reveal = page.getByRole("form", { name: "Reveal number" });
  await reveal.getByRole("button", { name: "Reveal number" }).click();
  await expect(reveal.getByRole("status")).toHaveText("Passport number: TEST123456");

  await page.reload();
  const log = page.getByRole("region", { name: "Access log" });
  await expect(log.getByText(/Passport number revealed/).first()).toBeVisible();
  await expect(log.getByText(/Emergency contact added/).first()).toBeVisible();
  await expect(log).not.toContainText("TEST123456");
  await expect(page.getByText("You have no engagements to share with yet.")).toBeVisible();

  await page.goto(`/${slug}/me/profile`);
  const names = page.getByRole("form", { name: "Name parts" });
  await names.getByLabel("Given name").fill("Wren");
  await names.getByLabel("Family name").fill("Details");
  await names.getByRole("button", { name: "Save name parts" }).click();
  await expect(names.getByRole("status")).toHaveText("Saved.");
  await expectAccessible(page);
});
