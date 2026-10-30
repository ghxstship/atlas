import { expect as baseExpect, settle, test } from "./engine-test";
import { expectAccessible } from "./support";
import { createProject, newOwnerOrg } from "./p8-support";

/**
 * P8 (RRR-222, parity gap G-35; Section 11.7): a stage manager shifts the cues still to come. After the first cue is
 * called, Shift cues still to come offers only the other two; selecting all of them and shifting +5 previews "2 cues
 * move +5 min; 1 called cue stays", applies in one transaction, and Cmd or Ctrl+Z sets the old times back. The
 * controls are reachable by keyboard alone.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("shift the cues still to come and undo it", async ({ page }) => {
  const slug = await newOwnerOrg(page, "p8cues", "Sky Stage");
  await createProject(page, slug, "PCU", "Cue Night");
  await page.goto(`/${slug}/show/run-of-show?create=1`);
  const sheet = page.getByRole("dialog", { name: "New running order" });
  await sheet.getByLabel("Name").fill("Cue Night Running Order");
  await sheet.getByLabel("Show day").fill("2027-03-13");
  await sheet.getByRole("button", { name: "Create running order" }).click();
  await page.waitForURL(/peek=/);
  const runUrl = page.url();
  const cues = page.getByRole("list", { name: "Cues of Cue Night Running Order" });
  for (const [label, at] of [
    ["House to Half", "19:00"],
    ["Walk-in Music Out", "19:10"],
    ["Headliner On", "19:20"],
  ] as const) {
    await page.getByLabel("Cue", { exact: true }).fill(label);
    await page.getByLabel("Planned time").fill(at);
    await page.getByRole("button", { name: "Add cue" }).click();
    await expect(cues).toContainText(label);
  }

  // Call the first cue, then come back to edit mode.
  await page.goto(`${runUrl}&live=1`);
  await page.getByRole("button", { name: "Call next cue" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Current cue: House to Half" }),
  ).toBeVisible();
  await page.goto(runUrl);

  const shift = page.getByRole("region", { name: "Shift cues still to come" });
  await expect(shift).toBeVisible();
  await settle(page);
  await shift.getByLabel("Select all cues still to come (2)").focus();
  await page.keyboard.press("Space");
  await shift.getByLabel("Minutes").fill("+5");
  await shift.getByRole("button", { name: "Preview" }).click();
  await expect(shift).toContainText("2 cues move +5 min; 1 called cue stays.");
  await expectAccessible(page);
  await shift.getByRole("button", { name: "Shift 2 cues" }).click();
  await expect(page.getByText("Shifted 2 cues +5 min.").first()).toBeVisible();
  await expect(cues).toContainText(/7:15/);
  await expect(cues).toContainText(/7:25/);

  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByText(/Undone: Shifted 2 cues/)).toBeVisible();
  await expect(cues).toContainText(/7:10/);
  await expect(cues).toContainText(/7:20/);
});
