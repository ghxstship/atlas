import { expect, test, type Browser, type Page } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * B3 showcaller portal (RRR-227, ADR 0142; gap G-80) on a fresh org, in two browser contexts: a member makes a
 * showcaller link for a running order; a visitor with no session enters the code, stands by and calls a cue,
 * nudges the plan, edits a cue's label and a department call, and pops out the clock; the member sees the call
 * "through a showcaller link"; revoking the link shows the visitor it is no longer available.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);

async function newOwnerOrg(page: Page): Promise<string> {
  const id = uniqueId();
  const slug = `b3p-${id}`;
  await signUp(page, { name: "Sky Stage", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Showcaller ${id}`, slug });
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

async function visitor(browser: Browser): Promise<Page> {
  return (await browser.newContext({ reducedMotion: "reduce" })).newPage();
}

test("an outside showcaller calls and edits one running order with a link and its code", async ({
  page,
  browser,
}) => {
  const slug = await newOwnerOrg(page);
  await page.goto(`/${slug}/show/run-of-show?create=1`);
  const sheet = page.getByRole("dialog", { name: "New running order" });
  await sheet.getByLabel("Name").fill("Opening Night Running Order");
  await sheet.getByLabel("Show day").fill("2027-03-13");
  await sheet.getByRole("button", { name: "Create running order" }).click();
  await page.waitForURL(/peek=/);
  for (const [label, time] of [
    ["House to Half", "19:55"],
    ["Walk-in Music Out", "20:00"],
    ["Headliner On", "20:10"],
  ] as const) {
    await page.getByLabel("Cue", { exact: true }).fill(label);
    await page.getByLabel("Planned time").fill(time);
    await page.getByRole("button", { name: "Add cue" }).click();
    await expect(
      page.getByRole("list", { name: "Cues of Opening Night Running Order" }),
    ).toContainText(label);
  }
  const runUrl = page.url();

  await page.getByRole("button", { name: "Showcaller links" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Showcaller links for Opening Night Running Order",
  });
  await expect(
    dialog.getByText(
      "Anyone with this link and code can call cues and edit this running order until it expires.",
    ),
  ).toBeVisible();
  await dialog.getByLabel("Showcaller").fill("Sam Okafor");
  await dialog.getByRole("button", { name: "Create showcaller link" }).click();
  const url = await dialog.getByRole("textbox", { name: "Link" }).inputValue();
  const code = await dialog.getByRole("textbox", { name: "Access code" }).inputValue();
  expect(code).toMatch(/^[0-9]{6}$/);
  const path = new URL(url).pathname;
  expect(path).toMatch(/^\/share\/showcaller\/xscl_[0-9a-f]{64}$/);
  await page.keyboard.press("Escape");

  const guest = await visitor(browser);
  await guest.goto(path);
  await guest.getByLabel("Access code").fill(code === "000000" ? "000001" : "000000");
  await guest.getByRole("button", { name: "Open" }).click();
  await expect(guest.getByText("That code is not right.", { exact: false })).toBeVisible();
  await guest.getByLabel("Access code").fill(code);
  await guest.getByRole("button", { name: "Open" }).click();
  await expect(guest.getByRole("heading", { name: "Opening Night Running Order" })).toBeVisible();
  await expect(guest.getByText("Calling as Sam Okafor")).toBeVisible();

  // Standby, then Go.
  await guest.getByRole("button", { name: "Standby: House to Half" }).click();
  await expect(guest.getByRole("status").filter({ hasText: "Standby: House to Half" })).toBeVisible(
    {
      timeout: 20_000,
    },
  );
  await guest.getByRole("button", { name: /^Go: call House to Half/ }).click();
  await expect(
    guest
      .getByRole("listitem")
      .filter({ hasText: "House to Half" })
      .getByText(/^Called /),
  ).toBeVisible({ timeout: 20_000 });

  // Nudge the remaining plan and edit an uncalled cue and its Lighting call.
  await guest.getByRole("button", { name: "Nudge +1 min" }).click();
  await guest.getByRole("button", { name: "Edit Walk-in Music Out" }).click();
  const editor = guest.getByRole("form", { name: "Edit cue Walk-in Music Out" });
  await editor.getByLabel("Cue", { exact: true }).fill("Walk-in Music Fade");
  await editor.getByLabel("Lighting call").fill("LX 12 GO");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(guest.getByRole("listitem").filter({ hasText: "Walk-in Music Fade" })).toContainText(
    "Lighting · LX 12 GO",
    { timeout: 20_000 },
  );

  // The pop-out clock shows the room clock from the portal's own read.
  const [clock] = await Promise.all([
    guest.waitForEvent("popup"),
    guest.getByRole("button", { name: "Open clock" }).click(),
  ]);
  await expect(clock.getByRole("button", { name: "Room clock", pressed: true })).toBeVisible();
  await clock.close();

  // The member sees who called the cue: the showcaller, through the link.
  await page.goto(runUrl);
  await expect(page.getByText(/Called .* by Sam Okafor through a showcaller link/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Walk-in Music Fade")).toBeVisible();

  // Revoking stops the portal on its next ping or pull.
  await page.getByRole("button", { name: "Showcaller links" }).click();
  const again = page.getByRole("dialog", {
    name: "Showcaller links for Opening Night Running Order",
  });
  await again.getByRole("button", { name: "Revoke" }).first().click();
  await again.getByRole("button", { name: "Confirm" }).click();
  await expect(guest.getByText("This link is not available")).toBeVisible({ timeout: 30_000 });
  await guest.context().close();
});
