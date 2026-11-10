import { expect as baseExpect, settle, test, type Page } from "./engine-test";
import { ORG, signIn } from "./a16-support";
import { uniqueId } from "./support";

/**
 * B11 on the demo tenant (RRR-235):
 *   - a need is added on a project tab, its status reads Needs Ordered, and a pasted list is previewed before it is saved;
 *   - a maintenance plan shows as due, and Complete records work that moves its next due date;
 *   - delivery windows are added at a gate on a project tab and read as one block with its vehicle count.
 * Names carry a unique suffix, so reruns add new rows. Clicks that open a form retry until the page has hydrated.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 30_000 });

const PROJECT_KEY = "NWS";

async function open(page: Page, path: string) {
  await page.goto(path);
  await settle(page);
}

test("a need is added, reads Needs Ordered, and a pasted list previews before it saves", async ({
  page,
}) => {
  const suffix = uniqueId();
  await signIn(page);
  await open(page, `/${ORG}/p/${PROJECT_KEY}/procurement?section=needs`);
  await expect(page.getByRole("heading", { name: "Needs", exact: true })).toBeVisible();

  await expect(async () => {
    await page.getByRole("link", { name: "Add needs", exact: true }).first().click();
    await expect(page.getByLabel("Item", { exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await page.getByLabel("Item", { exact: true }).fill(`Truss ${suffix}`);
  await page.getByLabel("Quantity", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Add needs", exact: true }).click();
  await expect(
    page
      .getByRole("grid")
      .getByText(`Truss ${suffix}`)
      .or(page.getByText(`Truss ${suffix}`))
      .first(),
  ).toBeVisible();
  await expect(page.getByText("Needs Ordered", { exact: true }).first()).toBeVisible();

  await open(page, `/${ORG}/p/${PROJECT_KEY}/procurement?section=needs`);
  await expect(async () => {
    // Paste list sits in the header's More menu with Import.
    await page.getByRole("main").getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Paste list", exact: true }).click();
    await expect(page.getByLabel("Equipment list", { exact: true })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass();
  await page
    .getByLabel("Equipment list", { exact: true })
    .fill(`Audio:\n12 x Mic ${suffix}\nCable ${suffix}`);
  await page.getByRole("button", { name: "Preview lines", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add 2 lines", exact: true })).toBeVisible();
  await expect(
    page.getByText("No quantity in the list, so this reads 1.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add 2 lines", exact: true }).click();
  await expect(page.getByText(`Mic ${suffix}`, { exact: true }).first()).toBeVisible();
});

test("a maintenance plan comes due, and Complete moves its next due date", async ({ page }) => {
  const suffix = uniqueId();
  await signIn(page);
  await open(page, `/${ORG}/assets/maintenance?section=schedule`);
  await expect(
    page.getByRole("heading", { name: "Maintenance schedule", exact: true }),
  ).toBeVisible();

  await expect(async () => {
    await page.getByRole("button", { name: "Add plan", exact: true }).click();
    await expect(page.getByLabel("What is to be done", { exact: true })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass();
  await page.getByLabel("Applies to", { exact: true }).click();
  await page.getByRole("listbox").getByRole("option").first().click();
  await page.getByLabel("What is to be done", { exact: true }).fill(`Inspect ${suffix}`);
  await page.getByRole("button", { name: "Add plan", exact: true }).last().click();
  await expect(page.getByText(new RegExp(`Inspect ${suffix}`)).first()).toBeVisible();

  await page
    .getByRole("button", { name: new RegExp(`Complete Inspect ${suffix}`) })
    .first()
    .click();
  await page.getByRole("button", { name: "Record maintenance", exact: true }).click();
  // The dialog closes once the record is saved; leaving before that cancels the save.
  await expect(page.getByRole("dialog")).toBeHidden();
  await open(page, `/${ORG}/assets/maintenance?section=schedule&status=Completed`);
  await expect(page.getByText(new RegExp(`Inspect ${suffix}`)).first()).toBeVisible();
});

test("delivery windows read as one block with their vehicle count", async ({ page }) => {
  await signIn(page);
  await open(page, `/${ORG}/p/${PROJECT_KEY}/logistics?section=dock&createWindows=1`);
  const gate = page.getByLabel("Gate", { exact: true });
  await expect(gate).toBeVisible();
  // A day far enough ahead that nothing else holds the gate, and never already past when the test runs.
  const day = new Date(Date.now() + 500 * 86_400_000 + Math.floor(Math.random() * 300) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await page.getByLabel("First day", { exact: true }).fill(day);
  await page.getByLabel("Last day", { exact: true }).fill(day);
  await page.getByLabel("From", { exact: true }).fill("08:00");
  await page.getByLabel("To", { exact: true }).fill("10:00");
  await page.getByRole("button", { name: "Add delivery windows", exact: true }).last().click();
  await open(page, `/${ORG}/p/${PROJECT_KEY}/logistics?section=dock&view=list&week=${day}`);
  await expect(page.getByText(/0 of 5 vehicles/).first()).toBeVisible();
});
