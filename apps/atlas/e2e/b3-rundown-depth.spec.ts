import { cognitiveLoadProblems } from "./a11y/checks";
import { expectDialogWithinLoad } from "./b3-support";
import { expect, test, type Page } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * B3 rundown depth (RRR-227, ADR 0142; gap G-73) on a fresh org: a cue field with a color-coded choice and the
 * Client audience is defined in Settings and filled in the cue editor, where its chip shows in the cue's row; a
 * segment gets a color; a library segment is made, inserted into the running order, edited in the library and
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

test("cue fields with colors, segment colors and the segment library", async ({ page }) => {
  const slug = await newOwnerOrg(page);

  // A Choice cue field with a colored option, for the crew and the Client.
  await page.goto(`/${slug}/settings/custom-fields`);
  const add = page.getByRole("form", { name: "Add a field" });
  await add.getByLabel("Records").selectOption({ label: "Cues" });
  await add.getByLabel("Label").fill("Camera");
  await add.getByLabel("Type").selectOption({ label: "Choice" });
  await add.getByRole("button", { name: "Add field" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Camera" });
  const choice = page.getByRole("form", { name: "Add a choice to Camera" });
  await choice.getByLabel("New choice").fill("Wide");
  await choice.getByLabel("Color").selectOption({ label: "Sky blue" });
  await choice.getByRole("button", { name: "Add choice" }).click();
  await expect(row.getByText("Wide (Sky blue)")).toBeVisible();
  await expect(row.getByText("For: Crew")).toBeVisible();
  const audiences = page.getByRole("form", { name: "Who Camera is for" });
  await audiences.getByLabel("Client").check();
  await audiences.getByRole("button", { name: "Save audiences" }).click();
  await expect(row.getByText("For: Crew, Client")).toBeVisible();

  // A running order with a cue in a colored segment, and the field filled in.
  await page.goto(`/${slug}/show/run-of-show?create=1`);
  const sheet = page.getByRole("dialog", { name: "New running order" });
  await sheet.getByLabel("Name").fill("Opening Night Running Order");
  await sheet.getByLabel("Show day").fill("2027-03-13");
  await sheet.getByRole("button", { name: "Create running order" }).click();
  await page.waitForURL(/peek=/);
  await page.getByLabel("Cue", { exact: true }).fill("House to Half");
  await page.getByRole("button", { name: "Add cue" }).click();
  await page.getByRole("button", { name: "Edit House to Half" }).click();
  const editor = page.getByRole("group", { name: "Edit cue House to Half" });
  await editor.getByLabel("Segment", { exact: true }).fill("Act I");
  await editor.getByLabel("Segment color").selectOption({ label: "Vermillion" });
  // The editor is one screen of the peek: at most seven visible fields and one primary action on each tab.
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await editor.getByRole("tab", { name: "Words" }).click();
  await editor.getByLabel("Script", { exact: true }).fill("Ladies and gentlemen, welcome.");
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await editor.getByRole("tab", { name: "Calls" }).click();
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Act I").first()).toBeVisible();

  await page.getByRole("button", { name: "Edit House to Half" }).click();
  // The color shown follows the segment typed, without a pick.
  const reopened = page.getByRole("group", { name: "Edit cue House to Half" });
  await expect(reopened.getByLabel("Segment color")).toHaveValue("cat-6");
  await reopened.getByLabel("Segment", { exact: true }).fill("Act II");
  await expect(reopened.getByLabel("Segment color")).toHaveValue("");
  await reopened.getByLabel("Segment", { exact: true }).fill("Act I");
  await reopened.getByRole("tab", { name: "Fields" }).click();
  await expect(reopened.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  const fields = page.getByRole("region", { name: "Custom fields" });
  await fields.getByRole("button", { name: "Edit fields" }).click();
  // Save fields is the screen's one primary: Start live leaves while a cue is being edited.
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await fields.getByLabel("Camera").selectOption({ label: "Wide" });
  await fields.getByRole("button", { name: "Save fields" }).click();
  await expect(fields.getByText("Wide")).toBeVisible();
  await reopened.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Camera: Wide")).toBeVisible({ timeout: 20_000 });
  const runUrl = page.url();

  // A library segment with two cues, inserted after the cue.
  await page.goto(`/${slug}/show/segments?create=1`);
  const create = page.getByRole("dialog", { name: "New segment" });
  await expectDialogWithinLoad(create);
  await create.getByLabel("Segment name").fill("Awards Block");
  await create.getByLabel("Color").selectOption({ label: "Yellow" });
  await create.getByRole("button", { name: "Save segment" }).click();
  await page.waitForURL(/peek=/);
  // The peek reads first: its changes open dialogs, and Publish to shows waits for a copy.
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await page.getByRole("button", { name: "Edit segment" }).click();
  const editSegment = page.getByRole("dialog", { name: "Edit segment" });
  await expectDialogWithinLoad(editSegment);
  await editSegment.getByLabel("Description").fill("Three awards and the walk-off.");
  await editSegment.getByRole("button", { name: "Save segment" }).click();
  await expect(editSegment).toBeHidden();
  for (const label of ["Award One", "Walk-off"]) {
    await page.getByRole("button", { name: "Add cue" }).click();
    const form = page.getByRole("dialog", { name: "Add cue" });
    await expectDialogWithinLoad(form);
    await form.getByRole("textbox", { name: "Cue", exact: true }).fill(label);
    await form.getByRole("tab", { name: "Words" }).click();
    await expectDialogWithinLoad(form);
    await form.getByRole("tab", { name: "Calls" }).click();
    await expectDialogWithinLoad(form);
    await form.getByRole("button", { name: "Add cue" }).click();
    await expect(form).toBeHidden();
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
  const libraryCue = page.getByRole("dialog", { name: "Edit cue Award One" });
  await expectDialogWithinLoad(libraryCue);
  await libraryCue.getByRole("textbox", { name: "Cue", exact: true }).fill("Award One (Gold)");
  await libraryCue.getByRole("button", { name: "Save" }).click();
  await expect(libraryCue).toBeHidden();
  await expect(page.getByText("Library updated: publish to shows", { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await page.getByRole("button", { name: "Publish to shows" }).click();
  const publish = page.getByRole("dialog", { name: "Publish to shows" });
  await expectDialogWithinLoad(publish);
  await expect(publish.getByText("Local edits to those cues", { exact: false })).toBeVisible();
  await publish.getByRole("button", { name: /Publish version/ }).click();
  await expect(publish).toBeHidden();
  // The outcome stays in the peek after the dialog closes and after the refresh that brings the new copies.
  const outcome = page.getByRole("status", { name: "What publishing did" });
  await expect(outcome).toContainText("Opening Night Running Order: Published");
  await expect(page.getByText("Library updated: publish to shows", { exact: false })).toBeHidden({
    timeout: 20_000,
  });
  await expect(outcome).toContainText("Opening Night Running Order: Published");

  await page.goto(runUrl);
  await expect(
    page.getByRole("list", { name: "Cues of Opening Night Running Order" }),
  ).toContainText("Award One (Gold)");
});
