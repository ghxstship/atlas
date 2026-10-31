import { expect, test, type Page } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * B3 show channel (RRR-227, ADR 0142; gap G-79): in live mode the project's crew chat sits beside the running cue.
 * The Owner opens it, sends a message that appears without a reload, and M from the console reaches the message
 * box. Typing S or J there types letters and never stands a cue by. Client exclusion is the database's: pgTAP 2922
 * proves that a member engaged as Client is never added, reads nothing and is never notified.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

async function newOwnerOrg(page: Page): Promise<string> {
  const id = uniqueId();
  const slug = `b3c-${id}`;
  await signUp(page, { name: "Sky Stage", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Show Channel ${id}`, slug });
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

test("the show channel sits beside the running cue and keeps its keys", async ({ page }) => {
  const slug = await newOwnerOrg(page);
  await page.goto(`/${slug}/show/run-of-show?create=1`);
  const sheet = page.getByRole("dialog", { name: "New running order" });
  await sheet.getByLabel("Name").fill("Opening Night Running Order");
  await sheet.getByLabel("Show day").fill("2027-03-13");
  await sheet.getByRole("button", { name: "Create running order" }).click();
  await page.waitForURL(/peek=/);
  for (const label of ["House to Half", "Walk-in Music Out"]) {
    await page.getByLabel("Cue", { exact: true }).fill(label);
    await page.getByRole("button", { name: "Add cue" }).click();
    await expect(
      page.getByRole("list", { name: "Cues of Opening Night Running Order" }),
    ).toContainText(label);
  }
  await page.goto(`${page.url()}&live=1`);

  const panel = page.getByRole("region", { name: "Show channel" });
  await expect(panel.getByText("Clients are never in this channel.")).toBeVisible();
  await panel.getByRole("button", { name: "Open the show channel" }).click();
  const box = panel.getByLabel("Message the crew");
  await expect(box).toBeVisible({ timeout: 20_000 });

  // M from the console reaches the message box; S and J typed there are letters, not standby moves.
  const console_ = page.getByRole("region", { name: "Showcaller console" });
  await expect(console_).toBeFocused();
  const standbyLine = page.getByRole("status").filter({ hasText: /^(Standby|Next):/ });
  const shown = await standbyLine.textContent();
  await page.keyboard.press("m");
  await expect(box).toBeFocused();
  await page.keyboard.type("Standby SJ please");
  await expect(box).toHaveValue("Standby SJ please");
  await expect(standbyLine).toHaveText(shown ?? "");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByRole("list", { name: "Show channel messages" })).toContainText(
    "Standby SJ please",
    {
      timeout: 20_000,
    },
  );
  await expect(box).toHaveValue("");
});
