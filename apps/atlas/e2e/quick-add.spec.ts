import { expect as baseExpect, test, type Page } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A116 quick add (Section 11.7, ADR 0073, RRR-161): one line in a record collection's quick add row
 * sets the record's date, owner, category, kind and scope, shown as chips before it saves; plain
 * create, from the row and from the New record sheet, works as before; the Create menu's search
 * field and the shifts row do the same. Each run signs up a new owner in a new org.
 */
test.use({ reducedMotion: "reduce" });
// Sign-up, a new org, a project and a first visit to each page take a while under next dev.
test.describe.configure({ timeout: 180_000 });
// Saves revalidate the org's pages before the peek shows (A71).
const expect = baseExpect.configure({ timeout: 20_000 });

const KEY = "QAD";
const PROJECT = "Quick Add Journey";

async function newOrgWithProject(page: Page): Promise<string> {
  const id = uniqueId();
  const slug = `qad-${id}`;
  await signUp(page, { name: "Sam Scheduler", email: testEmail("quick", id) });
  await createOrganization(page, { name: `Quick ${id}`, slug });
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill(KEY);
  await dialog.getByLabel("Project name").fill(PROJECT);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/${KEY}/overview`);
  return slug;
}

/** The chips under a quick add field. */
function chipsOf(field: ReturnType<Page["getByRole"]>) {
  return field.locator("xpath=ancestor::form[1]/following-sibling::div[1]");
}

test("one line sets a record's date, owner, category, kind and scope; plain create still works", async ({
  page,
}) => {
  const slug = await newOrgWithProject(page);
  await page.goto(`/${slug}/work/all-records`);
  // The row loads with the page's other client code; a first visit under next dev compiles it.
  await page.waitForLoadState("networkidle");
  const field = page.getByRole("textbox", { name: "Quick add a record" });
  await expect(field).toBeVisible();

  await field.fill(`Truss Load Test Friday 8am @sam #rigging /inspection ~${KEY}-E01`);
  // Every token resolves to what the owner may see and shows as a chip before saving.
  const chips = chipsOf(field);
  await expect(chips.getByText("Sam Scheduler")).toBeVisible();
  await expect(chips.getByText("Rigging", { exact: true })).toBeVisible();
  await expect(chips.getByText("Inspection")).toBeVisible();
  await expect(chips.getByText(PROJECT)).toBeVisible();
  await expect(chips.getByText("Friday 8am")).toBeVisible();
  await expect(chips.getByText("Truss Load Test", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Owner: Sam Scheduler" })).toHaveText(
    /^Truss Load Test, with .*When: Fri.*8:00/,
  );
  await expect(page.getByRole("button", { name: "Remove Category: Rigging" })).toBeVisible();
  await expectAccessible(page);

  await field.press("Enter");
  await page.waitForURL(new RegExp(`peek=${KEY}-1`));
  const peek = page.getByRole("dialog", { name: "Truss Load Test" });
  await expect(peek).toBeVisible();
  await expect(peek).toContainText("Inspection");
  await expect(peek).toContainText(PROJECT);
  await expect(peek).toContainText("5000.51.02");
  await expect(peek).toContainText("Sam Scheduler");
  await expect(peek).toContainText(/8:00\W?AM/);
  await expect(field).toHaveValue("");

  // A line with no tokens creates a Task with its title only, as the sheet would.
  await page.goto(`/${slug}/work/all-records`);
  await field.fill("Install the rig");
  await field.press("Enter");
  await page.waitForURL(new RegExp(`peek=${KEY}-2`));
  const plain = page.getByRole("dialog", { name: "Install the rig" });
  await expect(plain).toContainText("Task");
  await expect(plain).toContainText("Unassigned");

  // A token that names no one stays in the title.
  await page.goto(`/${slug}/work/all-records`);
  await field.fill("Check the hoist @nobody");
  await expect(chips.getByText("Check the hoist @nobody", { exact: true })).toBeVisible();

  // The New record sheet works as before.
  await page.goto(`/${slug}/work/all-records?create=1`);
  const sheet = page.getByRole("dialog", { name: "New record" });
  await sheet.getByLabel("Kind").selectOption("Task");
  await sheet.getByLabel("Title").fill("Hang the banner");
  await sheet.getByRole("button", { name: "Create record" }).click();
  await page.waitForURL(new RegExp(`peek=${KEY}-3`));
});

test("the Create menu adds a record from its search field, and a kind's name still opens its flow", async ({
  page,
}) => {
  const slug = await newOrgWithProject(page);
  await page.goto(`/${slug}/home`);
  await page.waitForLoadState("networkidle");
  await page.locator("[data-create-trigger]").click();
  const menu = page.getByRole("dialog", { name: "Create" });
  await expect(menu).toBeVisible({ timeout: 15_000 });
  const search = menu.getByRole("combobox");

  await search.fill("Shift");
  await expect(menu.getByRole("option").first()).toHaveText(/^Shift/);
  await expect(menu.getByText("Quick add")).toHaveCount(0);

  await search.fill(`Rigging Plan /document @me ~${KEY} tomorrow 9am`);
  await expect(menu.getByRole("option", { name: "Add Rigging Plan as Document" })).toBeVisible();
  await expect(menu.getByText("Sam Scheduler")).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press("Enter");
  await page.waitForURL(new RegExp(`/${slug}/r/${KEY}-1$`));
  await expect(page.getByRole("heading", { name: "Rigging Plan", level: 1 })).toBeVisible();
});

test("one line plans a Draft shift with its role, person, scope and times", async ({ page }) => {
  const slug = await newOrgWithProject(page);
  await page.goto(`/${slug}/crew/shifts`);
  await page.waitForLoadState("networkidle");
  const field = page.getByRole("textbox", { name: "Quick add a shift" });
  await field.fill(`#stagehand @me ~${KEY}-E01 Friday 8am-4pm`);
  const chips = chipsOf(field);
  await expect(chips.getByText("Lead Stagehand / Deck Crew Chief")).toBeVisible();
  await expect(chips.getByText("Sam Scheduler")).toBeVisible();
  await expectAccessible(page);
  await field.press("Enter");
  await page.waitForURL(/peek=/);
  await expect(page.getByText("Lead Stagehand / Deck Crew Chief").first()).toBeVisible();

  // Words a shift has no field for are refused with a hint, and the line stays.
  await field.fill("Stagehand Friday 8am");
  await field.press("Enter");
  await expect(page.getByText("A shift has no title. Name its role with #")).toBeVisible();
  await expect(field).toHaveValue("Stagehand Friday 8am");
});
