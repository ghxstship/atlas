import { expect as baseExpect, test, type Page } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A124 archive (Section 4.10, RRR-169): an archived record leaves its collection and search, shows
 * under the Archived filter with when it was archived, and returns to both when unarchived; a
 * document does the same on Knowledge > Documents, and an archived custom object record still opens
 * from a link to it. Each run signs up a new owner in a new org.
 */
test.use({ reducedMotion: "reduce" });
// Sign-up, a new org, a project and a first visit to each page take a while under next dev.
test.describe.configure({ timeout: 180_000 });
// Archiving revalidates the org's pages before the list shows the change (A71).
const expect = baseExpect.configure({ timeout: 20_000 });

const KEY = "ARC";

async function newOrgWithProject(page: Page): Promise<string> {
  const id = uniqueId();
  const slug = `arc-${id}`;
  await signUp(page, { name: "Avery Archivist", email: testEmail("archive", id) });
  await createOrganization(page, { name: `Archive ${id}`, slug });
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill(KEY);
  await dialog.getByLabel("Project name").fill("Archive Journey");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/${KEY}/overview`);
  return slug;
}

test("an archived record leaves the list and search, shows under Archived, and returns when unarchived", async ({
  page,
}) => {
  const slug = await newOrgWithProject(page);
  // A live record that shares the search word, so search shows it has answered before the archived
  // record's absence is checked.
  for (const [n, title] of [
    [1, "Inspect the zephyr hoist"],
    [2, "Install the zephyr truss"],
  ] as const) {
    await page.goto(`/${slug}/work/all-records?create=1`);
    const sheet = page.getByRole("dialog", { name: "New record" });
    await sheet.getByLabel("Kind").selectOption("Task");
    await sheet.getByLabel("Title").fill(title);
    await sheet.getByRole("button", { name: "Create record" }).click();
    await page.waitForURL(new RegExp(`peek=${KEY}-${n}`));
  }

  // Archive from the peek: it closes, and the record leaves the list.
  const peek = page.getByRole("dialog", { name: "Install the zephyr truss" });
  await peek.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page).not.toHaveURL(/peek=/);
  const list = page.getByRole("main");
  await expect(list.getByText("Install the zephyr truss")).toHaveCount(0);

  // Search leaves it out, and is:archived finds it.
  await page.keyboard.press("ControlOrMeta+k");
  const menu = page.getByRole("dialog").filter({ has: page.getByRole("combobox") });
  await menu.getByRole("combobox").fill("zephyr");
  await expect(menu.getByRole("option", { name: /Inspect the zephyr hoist/ })).toBeVisible();
  await expect(menu.getByRole("option", { name: /Install the zephyr truss/ })).toHaveCount(0);
  await menu.getByRole("combobox").fill("zephyr is:archived");
  await expect(menu.getByRole("option", { name: /Install the zephyr truss/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // Under Archived, with when it was archived.
  await page.getByLabel("Archived", { exact: true }).selectOption("only");
  await expect(page).toHaveURL(/archived=only/);
  await list.getByText("Install the zephyr truss").first().click();
  const archived = page.getByRole("dialog", { name: "Install the zephyr truss" });
  await expect(archived.getByText(/^Archived on /)).toBeVisible();
  await expectAccessible(page);

  // Unarchive: it leaves the Archived list and is back in the default one.
  await archived.getByRole("button", { name: "Unarchive" }).click();
  await expect(page).not.toHaveURL(/peek=/);
  await expect(list.getByText("Install the zephyr truss")).toHaveCount(0);
  await page.getByLabel("Archived", { exact: true }).selectOption("");
  await expect(page).not.toHaveURL(/archived=/);
  await expect(list.getByText("Install the zephyr truss").first()).toBeVisible();
});

test("a document is archived from its peek and unarchived from the Archived list", async ({
  page,
}) => {
  const slug = await newOrgWithProject(page);
  await page.goto(`/${slug}/knowledge/documents?create=1`);
  const drawer = page.getByRole("dialog", { name: "Add document" });
  await drawer.getByLabel("Title").fill("Zephyr Rigging Plan");
  await drawer
    .getByLabel("File location")
    .fill("https://files.example.com/zephyr-rigging-plan.pdf");
  await drawer.getByLabel("File to fingerprint").setInputFiles({
    name: "zephyr-rigging-plan.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 zephyr rigging plan"),
  });
  await drawer.getByRole("button", { name: "Add document" }).click();
  await page.waitForURL(/peek=/);

  const peek = page.getByRole("dialog", { name: "Zephyr Rigging Plan" });
  await peek.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page).not.toHaveURL(/peek=/);
  const list = page.getByRole("main");
  await expect(list.getByText("Zephyr Rigging Plan")).toHaveCount(0);

  await page.getByLabel("Archived", { exact: true }).selectOption("include");
  await list.getByText("Zephyr Rigging Plan").first().click();
  const archived = page.getByRole("dialog", { name: "Zephyr Rigging Plan" });
  await archived.getByRole("button", { name: "Unarchive" }).click();
  await page.getByLabel("Archived", { exact: true }).selectOption("");
  await expect(list.getByText("Zephyr Rigging Plan").first()).toBeVisible();
});

test("an archived custom object record still opens from a link to it", async ({ page }) => {
  const slug = await newOrgWithProject(page);
  const id = uniqueId();
  const label = `Zephyr Props ${id.toUpperCase()}`;
  const key = `zephyr_props_${id}`;
  await page.goto(`/${slug}/settings/custom-objects`);
  await page.getByLabel("Name", { exact: true }).fill(label);
  await page.getByRole("button", { name: "Define the object" }).click();
  await expect(page.getByText("Object defined. Add its fields next.")).toBeVisible();
  const card = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: label }) });
  await expect(card.getByText(`/api/v1/objects/${key}`)).toBeVisible();
  await card.getByRole("link", { name: `Open ${label} records` }).click();
  await page
    .getByRole("link", { name: `New ${label} record` })
    .first()
    .click();
  const drawer = page.getByRole("dialog", { name: `New ${label} record` });
  await drawer.getByLabel("Title").fill("Zephyr breakaway chair");
  await drawer.getByRole("button", { name: "Create the record" }).click();
  await expect(drawer).toBeHidden();

  // Archive it from its peek: it leaves the list.
  const list = page.getByRole("main");
  await list.getByText("Zephyr breakaway chair").first().click();
  await expect(page).toHaveURL(/peek=/);
  const recordId = new URL(page.url()).searchParams.get("peek");
  const peek = page.getByRole("dialog", { name: /Zephyr breakaway chair/ });
  await peek.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page).not.toHaveURL(/peek=/);
  await expect(list.getByText("Zephyr breakaway chair")).toHaveCount(0);

  // The link a record's Related section gives it opens the archived record, ready to unarchive.
  await page.goto(`/${slug}/objects/${key}?peek=${recordId}`);
  const archived = page.getByRole("dialog", { name: /Zephyr breakaway chair/ });
  await expect(archived.getByText(/^Archived on /)).toBeVisible();
  await archived.getByRole("button", { name: "Unarchive" }).click();
  await expect(page).not.toHaveURL(/peek=/);
  await expect(list.getByText("Zephyr breakaway chair").first()).toBeVisible();
});
