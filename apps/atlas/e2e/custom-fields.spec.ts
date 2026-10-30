import type { Locator } from "@playwright/test";
import { expect as baseExpect, settle, test, type Page } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A117 custom fields and the Add filter control (RRR-162; Section 4.5.6 org settings item 16, Section 11.15):
 * an Owner defines a required, filterable Choice field on records in Settings, the New record sheet refuses a
 * record without it and saves it with one, the record's peek shows it and edits it, the records table shows it as
 * a column, Add filter narrows the list to one value, the filtered list is saved as a view, and reopening the view
 * brings the filter back. A filterable Text field on vendors is filled on the create form and filtered with
 * contains on the vendor directory. Each run signs up a new owner in a new org on the local stack.
 */

test.use({ reducedMotion: "reduce" });
// Saves re-render the org's pages (revalidatePath on the org layout) before the change shows (A71).
const expect = baseExpect.configure({ timeout: 20_000 });

/**
 * Clicks a control until what it opens shows. The Add filter control and the Saved views menu load after the
 * list, so a click that lands before they hydrate is lost (A71).
 */
async function openWith(page: Page, trigger: Locator, opened: Locator) {
  await settle(page);
  await expect(async () => {
    await trigger.click();
    await expect(opened).toBeVisible({ timeout: 5_000 });
  }).toPass();
}

async function openFilterEditor(page: Page) {
  const editor = page.getByRole("dialog", { name: "Add a filter" });
  await openWith(page, page.getByRole("button", { name: "Add filter" }), editor);
  return editor;
}

async function newOwnerOrg(page: Page): Promise<string> {
  const id = uniqueId();
  const slug = `cf-${id}`;
  await signUp(page, { name: "Casey Fields", email: testEmail("fields", id) });
  await createOrganization(page, { name: `Fields ${id}`, slug });
  return slug;
}

async function createProject(page: Page, slug: string, key: string, name: string) {
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill(key);
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/${key}/overview`);
}

/** Adds a field in Settings, Custom fields; Choice fields get their choices. */
async function addField(
  page: Page,
  slug: string,
  input: {
    target: string;
    label: string;
    type: string;
    required?: boolean;
    choices?: string[];
  },
) {
  await page.goto(`/${slug}/settings/custom-fields`);
  const form = page.getByRole("form", { name: "Add a field" });
  await form.getByLabel("Records").selectOption({ label: input.target });
  await form.getByLabel("Label").fill(input.label);
  await form.getByLabel("Type").selectOption({ label: input.type });
  if (input.required) await form.getByLabel("Required on every record").check();
  await form.getByLabel("Filterable in views").check();
  await form.getByRole("button", { name: "Add field" }).click();
  const row = page.getByRole("listitem").filter({ hasText: input.label });
  await expect(row.getByText("Filterable")).toBeVisible();
  for (const choice of input.choices ?? []) {
    const add = page.getByRole("form", { name: `Add a choice to ${input.label}` });
    await add.getByLabel("New choice").fill(choice);
    await add.getByRole("button", { name: "Add choice" }).click();
    await expect(row.getByText(new RegExp(`Choices: .*${choice}`))).toBeVisible();
  }
}

async function newTask(page: Page, slug: string, title: string, dock: string) {
  await page.goto(`/${slug}/work/all-records?create=1`);
  const sheet = page.getByRole("dialog", { name: "New record" });
  await sheet.getByLabel("Kind").selectOption("Task");
  await sheet.getByLabel("Title").fill(title);
  await sheet.getByLabel("Dock door").selectOption({ label: dock });
  await sheet.getByRole("button", { name: "Create record" }).click();
  await page.waitForURL(/peek=/);
}

test("a custom field is defined in Settings, filled on a record, filtered on and kept in a saved view", async ({
  page,
}) => {
  test.setTimeout(8 * 60_000);
  const slug = await newOwnerOrg(page);
  await createProject(page, slug, "CFJ", "Custom Field Journey");
  await addField(page, slug, {
    target: "Records",
    label: "Dock door",
    type: "Choice",
    required: true,
    choices: ["North", "South"],
  });

  // The New record sheet holds the record back until the required field has a value.
  await page.goto(`/${slug}/work/all-records?create=1`);
  const sheet = page.getByRole("dialog", { name: "New record" });
  await sheet.getByLabel("Kind").selectOption("Task");
  await sheet.getByLabel("Title").fill("Stage the north dock");
  await expect(sheet.getByLabel("Dock door")).toBeVisible();
  await sheet.getByRole("button", { name: "Create record" }).click();
  await expect(sheet.getByText("Dock door is required. Enter a value.")).toBeVisible();
  await expect(sheet.getByLabel("Dock door")).toBeFocused();
  await expectAccessible(page);
  await sheet.getByLabel("Dock door").selectOption({ label: "North" });
  await sheet.getByRole("button", { name: "Create record" }).click();
  await page.waitForURL(/peek=CFJ-1/);

  // The peek shows the value.
  const peek = page.getByRole("dialog", { name: "Stage the north dock" });
  const fields = peek.getByRole("region", { name: "Custom fields" });
  await expect(fields.getByText("North")).toBeVisible();
  await expectAccessible(page);

  // A second record starts on North and is moved to South from its peek.
  await newTask(page, slug, "Stage the south dock", "North");
  const second = page.getByRole("dialog", { name: "Stage the south dock" });
  const secondFields = second.getByRole("region", { name: "Custom fields" });
  await secondFields.getByRole("button", { name: "Edit fields" }).click();
  await secondFields.getByLabel("Dock door").selectOption({ label: "South" });
  await secondFields.getByRole("button", { name: "Save fields" }).click();
  await expect(secondFields.getByText("South")).toBeVisible();
  await expect(secondFields.getByRole("button", { name: "Edit fields" })).toBeVisible();

  // The record page shows the same section.
  await page.goto(`/${slug}/r/CFJ-2`);
  await expect(
    page.getByRole("region", { name: "Custom fields" }).getByText("South"),
  ).toBeVisible();

  // The table shows the field as a column, and Add filter narrows the list to North.
  await page.goto(`/${slug}/work/all-records?view=table`);
  await expect(page.getByRole("columnheader", { name: "Dock door" })).toBeVisible();
  await expect(page.getByText("Stage the south dock")).toBeVisible();
  const editor = await openFilterEditor(page);
  await editor.getByLabel("Field").selectOption({ label: "Dock door" });
  await editor.getByLabel("Condition").selectOption({ label: "is" });
  await editor.getByLabel("Value").selectOption({ label: "North" });
  await expectAccessible(page);
  await editor.getByRole("button", { name: "Apply filter" }).click();
  await page.waitForURL(/cf\.dock_door=north/);
  await expect(page.getByText("Stage the south dock")).toHaveCount(0);
  await expect(page.getByText("Stage the north dock")).toBeVisible();
  await expect(page.getByRole("group", { name: "Filters" }).getByText("North")).toBeVisible();

  // The filtered list is saved as a view.
  await page.getByRole("button", { name: "Save view" }).click();
  const save = page.getByRole("dialog", { name: "Save current view" });
  await save.getByLabel("Name").fill("North dock");
  await save.getByRole("button", { name: "Save view" }).click();
  await expect(save).toHaveCount(0);

  // Reopening the view brings the filter back.
  await page.goto(`/${slug}/work/all-records`);
  await expect(page.getByText("Stage the south dock")).toBeVisible();
  const saved = page.getByRole("menuitem", { name: "North dock" });
  await openWith(page, page.getByRole("button", { name: /Saved views/ }), saved);
  await saved.click();
  await page.waitForURL(/cf\.dock_door=north/);
  await expect(page.getByText("Stage the north dock")).toBeVisible();
  await expect(page.getByText("Stage the south dock")).toHaveCount(0);

  // Removing the chip shows every record again.
  await page
    .getByRole("group", { name: "Filters" })
    .getByRole("button", { name: "Remove filter Dock door" })
    .click();
  await expect(page.getByText("Stage the south dock")).toBeVisible();
});

test("a vendor's custom field is filled on the create form and filtered with contains", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  const slug = await newOwnerOrg(page);
  await addField(page, slug, { target: "Vendors", label: "Union local", type: "Text" });

  for (const [name, local] of [
    ["Harbor Rigging", "IATSE Local 500"],
    ["Bayside Audio", "IBEW 349"],
  ] as const) {
    await page.goto(`/${slug}/vendors/directory?create=1`);
    const form = page.locator("#vendor-create");
    await form.getByLabel("Company name").fill(name);
    await form.getByLabel("Union local").fill(local);
    await form.getByRole("button", { name: "Add vendor" }).click();
    await page.waitForURL(/peek=/);
    await expect(
      page.getByRole("region", { name: "Custom fields" }).getByText(local),
    ).toBeVisible();
  }

  await page.goto(`/${slug}/vendors/directory?view=table`);
  await expect(page.getByRole("columnheader", { name: "Union local" })).toBeVisible();
  const editor = await openFilterEditor(page);
  await editor.getByLabel("Field").selectOption({ label: "Union local" });
  await editor.getByLabel("Condition").selectOption({ label: "contains" });
  await editor.getByLabel("Value").fill("iatse");
  await editor.getByRole("button", { name: "Apply filter" }).click();
  await page.waitForURL(/cf\.union_local\.contains=iatse/);
  await expect(page.getByText("Harbor Rigging")).toBeVisible();
  await expect(page.getByText("Bayside Audio")).toHaveCount(0);
});
