import { expect, test, type Page } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * B3 show channel (RRR-227, ADR 0142; gap G-79): in live mode the project's crew chat sits beside the running cue.
 * The Owner opens it and writes; a Manager who joined the org afterwards is offered Join, joins, reads the history
 * and answers, and each sees the other's message arrive without a reload (Realtime). M from the console reaches the
 * message box, S and J typed there are letters, and Space on the channel's Send button sends rather than calling a
 * cue. Client exclusion is the database's and is proved by pgTAP 2922 (never added, reads nothing once engaged as
 * Client, never notified); the panel's Open and Join offers follow app.show_channel_status (show-keys-dom.test.ts).
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);

async function newOwnerOrg(page: Page, id: string): Promise<string> {
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

/** A sent message lands in the panel's list: the sender rereads after sending, the other side through Realtime. */
async function expectMessage(page: Page, text: string): Promise<void> {
  await expect(
    page
      .getByRole("region", { name: "Show channel" })
      .getByRole("list", { name: "Show channel messages" }),
  ).toContainText(text, { timeout: 20_000 });
}

test("the show channel sits beside the running cue, takes a joiner and delivers live", async ({
  page,
  browser,
}) => {
  const id = uniqueId();
  const slug = await newOwnerOrg(page, id);
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
  const liveUrl = `${page.url()}&live=1`;
  await page.goto(liveUrl);

  // The Owner opens the channel and writes first.
  const panel = page.getByRole("region", { name: "Show channel" });
  await expect(panel.getByText("Clients are never in this channel.")).toBeVisible();
  await panel.getByRole("button", { name: "Open the show channel" }).click();
  const box = panel.getByLabel("Message the crew");
  await expect(box).toBeVisible({ timeout: 20_000 });
  await box.fill("Doors in five");
  await panel.getByRole("button", { name: "Send" }).click();
  await expectMessage(page, "Doors in five");

  // M from the console reaches the message box; S and J typed there are letters, not standby moves, and Space
  // on Send sends instead of calling a cue.
  const console_ = page.getByRole("region", { name: "Showcaller console" });
  await console_.focus();
  const standbyLine = page.getByRole("status").filter({ hasText: /^(Standby|Next):/ });
  const shown = await standbyLine.textContent();
  await page.keyboard.press("m");
  await expect(box).toBeFocused();
  await page.keyboard.type("Standby SJ please");
  await expect(box).toHaveValue("Standby SJ please");
  await expect(standbyLine).toHaveText(shown ?? "");
  await panel.getByRole("button", { name: "Send" }).focus();
  await page.keyboard.press("Space");
  await expectMessage(page, "Standby SJ please");
  await expect(box).toHaveValue("");
  await expect(page.getByRole("status").filter({ hasText: "No cue called yet" })).toBeVisible();

  // A Manager joins the org after the channel opened, so it is offered Join rather than seeded.
  const managerEmail = testEmail("manager", id);
  await page.goto(`/${slug}/settings/members`);
  await page.getByLabel("Email", { exact: true }).fill(managerEmail);
  await page.locator("#invite-role").selectOption({ label: "Manager" });
  await page.getByRole("button", { name: "Create invite" }).click();
  const link = page.getByRole("textbox", { name: "Invitation link", exact: true });
  await expect(link).toHaveValue(/\/auth\/invite\/xinv_/);
  const inviteUrl = new URL(await link.inputValue());

  const managerContext = await browser.newContext({ reducedMotion: "reduce" });
  const manager = await managerContext.newPage();
  await manager.goto(inviteUrl.pathname);
  await expect(manager).toHaveURL(/\/auth\/sign-up\?next=/);
  await manager.getByLabel(/^Full name$/).fill("Max Manager");
  await manager.locator("#signup-email").fill(managerEmail);
  await manager.locator("#signup-password").fill(`E2e-${"passphrase"}-5172`);
  await manager.locator("#signup-age").check();
  await manager.getByRole("button", { name: "Create account" }).click();
  await manager.getByRole("button", { name: "Accept invitation" }).click();
  await manager.waitForURL(`**/${slug}/home`);

  await page.goto(liveUrl);
  await expectMessage(page, "Standby SJ please");
  await manager.goto(liveUrl);
  const managerPanel = manager.getByRole("region", { name: "Show channel" });
  await expect(managerPanel.getByRole("button", { name: "Open the show channel" })).toHaveCount(0);
  await managerPanel.getByRole("button", { name: "Join the show channel" }).click();
  await expectMessage(manager, "Doors in five");

  // Each side sees the other's message arrive with no reload.
  const managerBox = managerPanel.getByLabel("Message the crew");
  await managerBox.fill("Lighting is standing by");
  await managerPanel.getByRole("button", { name: "Send" }).click();
  await expectMessage(manager, "Lighting is standing by");
  await expectMessage(page, "Lighting is standing by");
  await box.fill("Thanks, going on my count");
  await panel.getByRole("button", { name: "Send" }).click();
  await expectMessage(manager, "Thanks, going on my count");

  await managerContext.close();
});
