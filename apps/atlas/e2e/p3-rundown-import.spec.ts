import { expect, test, type Page } from "@playwright/test";
import { expectAccessibleInBothThemes } from "./a16-support";
import { DEMO_ORG, reloadUntil, runImportWorker, signInAs } from "./a36-support";
import { describe, hardCodedText } from "./pseudo-checks";
import { uniqueId } from "./support";

/**
 * P3 (RRR-217, gap G-84, Section 4.6.2): import a rundown into a running order. From the running order's peek,
 * Import cues opens the wizard with the target and running order chosen; rows pasted from a Shoflo-style rundown
 * are previewed, mapped with the Playbook and header suggestions and the sample values visible, and committed. The
 * cues appear in order; importing the same rows again is a dry run of updates only; the batch is undone. The
 * import worker runs with the service role (runImportWorker).
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

/** A Shoflo-style rundown as copied from a spreadsheet: tab-separated, a quoted cell with a line break. */
function rundown(id: string): string {
  return [
    ["CUE ID", "ACT", "SCENE", "START TIME", "Length"],
    ["Q1", "Act I", `Walk-in ${id}`, "7:00 PM", "15"],
    ["Q2", "Act I", `"House to half ${id}\nslow"`, "19:15", "0:30"],
    ["", "Act II", `Host welcome ${id}`, "", "5"],
  ]
    .map((row) => row.join("\t"))
    .join("\n");
}

/** The en-XA wraps every catalog message; anything a person sees outside one is hard-coded (gate 16). */
async function expectNoHardCodedText(page: Page) {
  await page.context().addCookies([{ name: "xos-locale", value: "en-XA", url: page.url() }]);
  await page.reload();
  expect(describe(await hardCodedText(page))).toEqual([]);
  await page.context().clearCookies({ name: "xos-locale" });
  await page.reload();
}

test("rundown import: paste, map with suggestions, commit, re-import as updates, undo", async ({
  page,
}) => {
  const id = uniqueId();
  // The Producer holds show.run_of_show.write on the demo project.
  await signInAs(page, "producer@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/show/run-of-show?create=1`);
  const sheet = page.getByRole("dialog", { name: "New running order" });
  const project = sheet.getByLabel("Project");
  if ((await project.count()) > 0) {
    const nws = await project.locator("option", { hasText: /^NWS · / }).getAttribute("value");
    await project.selectOption(nws ?? "");
  }
  await sheet.getByLabel("Name").fill(`Rundown ${id}`);
  await sheet.getByLabel("Show day").fill("2027-04-10");
  await sheet.getByRole("button", { name: "Create running order" }).click();
  await page.waitForURL(/peek=/);
  const runId = new URL(page.url()).searchParams.get("peek") ?? "";

  // The peek offers Import cues, which opens the wizard on this running order.
  await page.getByRole("link", { name: "Import cues" }).click();
  await page.waitForURL(new RegExp(`/import\\?target=cues&runOfShow=${runId}`));
  await expect(page.getByLabel("Import into")).toHaveValue("cues");
  await expect(page.getByLabel("Running order")).toHaveValue(runId);

  // Paste the rows: the preview shows them as read, the quoted line break kept in its cell.
  await page.getByRole("radio", { name: "Pasted rows" }).click();
  await page.getByLabel("Rows", { exact: true }).fill(rundown(id));
  const preview = page.getByRole("table", { name: "First 3 rows" });
  await expect(preview).toContainText(`Walk-in ${id}`);
  await expect(preview).toContainText(`Host welcome ${id}`);
  await expectAccessibleInBothThemes(page);
  await page.getByRole("button", { name: "Read the rows" }).click();
  await page.waitForURL(/\?import=/);
  const importUrl = page.url();

  // Detect, then map: the Playbook map names the Playbook headers, header similarity the rest.
  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Map the columns" }));
  await expect(page.getByLabel("Column CUE ID")).toHaveValue("position");
  await expect(page.getByLabel("Column SCENE")).toHaveValue("label");
  await expect(page.getByLabel("Column START TIME")).toHaveValue("planned_at");
  await expect(page.getByLabel("Column Length")).toHaveValue("duration");
  await expect(page.getByText("From the Playbook column map").first()).toBeVisible();
  await expect(page.getByText("From the column name").first()).toBeVisible();
  // The uploader sees the first rows under each column and laid out by the choices.
  await expect(page.getByText(`Walk-in ${id}`).first()).toBeVisible();
  await expect(page.getByRole("table", { name: "Preview" })).toContainText("Cue number");
  await expectAccessibleInBothThemes(page);
  await expectNoHardCodedText(page);
  await page.getByRole("button", { name: "Confirm the mapping" }).click();

  // Validate and commit: three new cues, the unnumbered one appended after Q2.
  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Dry run" }));
  await expect(page.getByRole("region", { name: "Dry run" })).toContainText("3");
  await page.getByRole("button", { name: "Commit the import" }).click();
  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Undo the whole batch" }));
  await expect(page.getByText("3 rows were written")).toBeVisible();

  await page.goto(`/${DEMO_ORG}/show/run-of-show?peek=${runId}`);
  const cues = page.getByRole("list", { name: `Cues of Rundown ${id}` });
  await expect(cues.getByRole("listitem")).toHaveCount(3);
  await expect(cues.getByRole("listitem").nth(0)).toContainText(`Walk-in ${id}`);
  await expect(cues.getByRole("listitem").nth(2)).toContainText(`Host welcome ${id}`);

  // The same rows again: every row matches its cue, by number or by cue and time, so nothing is created.
  await page.getByRole("link", { name: "Import cues" }).click();
  await page.getByRole("radio", { name: "Pasted rows" }).click();
  await page.getByLabel("Rows", { exact: true }).fill(rundown(id));
  await page.getByRole("button", { name: "Read the rows" }).click();
  await page.waitForURL(/\?import=/);
  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Map the columns" }));
  await page.getByRole("button", { name: "Confirm the mapping" }).click();
  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Dry run" }));
  const dry = page.getByRole("region", { name: "Dry run" });
  await expect(dry.getByText("New records").locator("..")).toContainText("0");
  await expect(dry.getByText("Updates").locator("..")).toContainText("3");
  await page.getByRole("button", { name: "Cancel this import" }).click();

  // Undo the first batch: its three cues go to Trash.
  await page.goto(importUrl);
  await page.getByLabel("Why undo it").fill("Pasted the wrong rundown.");
  await page.getByRole("button", { name: "Undo the batch" }).click();
  await expect(page.getByRole("heading", { name: "Batch undone" })).toBeVisible();
  await expect(page.getByText("3 rows reverted, none kept.")).toBeVisible();
});
