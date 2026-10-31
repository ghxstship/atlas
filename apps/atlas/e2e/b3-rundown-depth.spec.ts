import { expect, test, type Page } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * B3 rundown depth (RRR-227, ADR 0142; gap G-73) on a fresh org: a cue field with a colour-coded choice and the
 * Client audience is defined in Settings and filled in the cue editor, where its chip shows in the cue's row; a
 * segment gets a colour; a library segment is made, inserted into the running order, edited in the library and
 * published back, with the outcome listed.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);

async function newOwnerOrg(page: Page): Promise<string> {
  const id = uniqueId();
  const slug = `b3d-${id}`;
  await signUp(page, { name: "Sky Stage", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Rundown ${id}`, slug });
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill("SHW");
  await dialog.getByLabel("Project name").fill("Summer Headline Weekend");
  await dialog.getByRole("button", { name: "More fields" }).click();
  await dialog.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await dialog.getByLabel("Tier of experience").selectOption({ index: 5 });
  await dialog.getByLabel("First production day").fill("2027-03-12");
  await dialog.getByLabel("Last production day").fill("2027-03-15");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/SHW/overview`);
  return slug;
}

test("cue fields with colours, segment colours and the segment library", async ({ page }) => {
  const slug = await newOwnerOrg(page);

  // A Choice cue field with a coloured option, for the crew and the Client.
  await page.goto(`/${slug}/settings/custom-fields`);
  const add = page.getByRole("form", { name: "Add a field" });
  await add.getByLabel("Records").selectOption({ label: "Cues" });
  await add.getByLabel("Label").fill("Camera");
  await add.getByLabel("Type").selectOption({ label: "Choice" });
  await add.getByRole("button", { name: "Add field" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Camera" });
  const choice = page.getByRole("form", { name: "Add a choice to Camera" });
  await choice.getByLabel("New choice").fill("Wide");
  await choice.getByLabel("Colour").selectOption({ label: "Sky blue" });
  await choice.getByRole("button", { name: "Add choice" }).click();
  await expect(row.getByText(/Choices: .*Wide \(Sky blue\)/)).toBeVisible();
  await expect(row.getByText("For: Crew")).toBeVisible();
  const audiences = page.getByRole("form", { name: "Who Camera is for" });
  await audiences.getByLabel("Client").check();
  await audiences.getByRole("button", { name: "Save audiences" }).click();
  await expect(row.getByText("For: Crew, Client")).toBeVisible();

  // A running order with a cue in a coloured segment, and the field filled in.
  await page.goto(`/${slug}/show/run-of-show?create=1`);
  const sheet = page.getByRole("dialog", { name: "New running order" });
  await sheet.getByLabel("Name").fill("Opening Night Running Order");
  await sheet.getByLabel("Show day").fill("2027-03-13");
  await sheet.getByRole("button", { name: "Create running order" }).click();
  await page.waitForURL(/peek=/);
  await page.getByLabel("Cue", { exact: true }).fill("House to Half");
  await page.getByRole("button", { name: "Add cue" }).click();
  await page.getByRole("button", { name: "Edit House to Half" }).click();
  const editor = page.getByRole("form", { name: "Edit cue House to Half" });
  await editor.getByLabel("Segment", { exact: true }).fill("Act I");
  await editor.getByLabel("Segment colour").selectOption({ label: "Vermillion" });
  await editor.getByLabel("Script").fill("Ladies and gentlemen, welcome.");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Act I").first()).toBeVisible();

  await page.getByRole("button", { name: "Edit House to Half" }).click();
  const fields = page.getByRole("region", { name: "Custom fields" });
  await fields.getByRole("button", { name: "Edit fields" }).click();
  await fields.getByLabel("Camera").selectOption({ label: "Wide" });
  await fields.getByRole("button", { name: "Save fields" }).click();
  await expect(fields.getByText("Wide")).toBeVisible();
  await page
    .getByRole("form", { name: "Edit cue House to Half" })
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(page.getByText("Camera: Wide")).toBeVisible({ timeout: 20_000 });
  const runUrl = page.url();

  // A library segment with two cues, inserted after the cue.
  await page.goto(`/${slug}/show/segments?create=1`);
  const create = page.getByRole("dialog", { name: "New segment" });
  await create.getByLabel("Segment name").fill("Awards Block");
  await create.getByLabel("Colour").selectOption({ label: "Yellow" });
  await create.getByRole("button", { name: "Save segment" }).click();
  await page.waitForURL(/peek=/);
  for (const label of ["Award One", "Walk-off"]) {
    const form = page.getByRole("form", { name: "Add cue" });
    await form.getByLabel("Cue", { exact: true }).fill(label);
    await form.getByRole("button", { name: "Add cue" }).click();
    await expect(page.getByRole("dialog").getByText(label)).toBeVisible();
  }

  await page.goto(runUrl);
  await page.getByRole("button", { name: "Insert segment" }).click();
  const insert = page.getByRole("dialog", {
    name: "Insert a library segment into Opening Night Running Order",
  });
  await insert
    .getByLabel("Segment", { exact: true })
    .selectOption({ label: "Awards Block (2 cues)" });
  await insert.getByRole("button", { name: "Insert segment" }).click();
  const cues = page.getByRole("list", { name: "Cues of Opening Night Running Order" });
  await expect(cues).toContainText("Award One");
  await expect(cues).toContainText("Walk-off");

  // Edit the library copy and publish it to the show.
  await page.goto(`/${slug}/show/segments`);
  await page.getByRole("button", { name: "Open" }).first().click();
  await page.getByRole("button", { name: "Edit Award One" }).click();
  await page
    .getByRole("form", { name: "Edit cue Award One" })
    .getByLabel("Cue", { exact: true })
    .fill("Award One (Gold)");
  await page
    .getByRole("form", { name: "Edit cue Award One" })
    .getByRole("button", { name: "Save" })
    .click();
  await expect(page.getByText("Library updated: publish to shows", { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Local edits to those cues", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /Publish version/ }).click();
  await expect(page.getByRole("status", { name: "What publishing did" })).toContainText(
    "Opening Night Running Order: Published",
  );

  await page.goto(runUrl);
  await expect(
    page.getByRole("list", { name: "Cues of Opening Night Running Order" }),
  ).toContainText("Award One (Gold)");
});
