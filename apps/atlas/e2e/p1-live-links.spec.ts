import { expect, test, type Browser, type Page } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * P1 live links (RRR-215, ADR 0130; gaps G-28 and G-76) on a fresh org:
 *   - a Schedule view shared live: the address and the code show once, a visitor with no session
 *     enters a wrong code and is refused, the right code shows the view, and a rename by a signed-in
 *     editor reaches the open page without a reload;
 *   - a display screen for a running order: the visitor enters the code, Backstage shows now and
 *     next, a called cue moves the screen, keys switch modes, and revoking takes it off the screen.
 * Every visitor is a fresh browser context with no session. Every link asks for its code.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

async function newOwnerOrg(page: Page): Promise<string> {
  const id = uniqueId();
  const slug = `p1-${id}`;
  await signUp(page, { name: "Sky Stage", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Live ${id}`, slug });
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

/** A visitor with no session, as on a venue laptop or a TV. */
async function visitor(browser: Browser): Promise<Page> {
  return (await browser.newContext({ reducedMotion: "reduce" })).newPage();
}

/** The address and code a dialog reveals once. */
async function revealed(page: Page): Promise<{ path: string; code: string }> {
  const url = await page.getByRole("textbox", { name: "Link" }).inputValue();
  const code = await page.getByRole("textbox", { name: "Access code" }).inputValue();
  expect(code).toMatch(/^[0-9]{6}$/);
  return { path: new URL(url).pathname, code };
}

async function enterCode(page: Page, code: string): Promise<void> {
  await page.getByLabel("Access code").fill(code);
  await page.getByRole("button", { name: "Open" }).click();
}

const wrong = (code: string) => (code === "000000" ? "000001" : "000000");

test("a saved Schedule view shared live opens with its code and updates without a reload", async ({
  page,
  browser,
}) => {
  const slug = await newOwnerOrg(page);
  const id = uniqueId();
  const title = `Stage Load-In Complete ${id}`;
  // A dated record: the Schedule, and so its live link, lists only records with a date.
  await page.goto(`/${slug}/p/SHW/schedule?create=1`);
  const create = page.getByRole("dialog").first();
  await create.getByLabel("Title").fill(title);
  await create.getByLabel("Due").fill("2027-03-12T10:00");
  await create
    .getByRole("button", { name: /Create/ })
    .last()
    .click();
  await page.waitForURL(/peek=/);
  const recordUrl = page.url();
  // The new record opens in its peek; close it to reach the view menu.
  await expect(page.getByRole("dialog").filter({ hasText: title })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: /Saved views/ }).click();
  await page.getByRole("menuitem", { name: "Save current view" }).click();
  const save = page.getByRole("dialog", { name: "Save current view" });
  const viewName = `Venue schedule ${id}`;
  await save.getByLabel("Name").fill(viewName);
  await save.getByRole("button", { name: "Save view" }).click();
  await expect(save).toHaveCount(0);

  await page.getByRole("button", { name: viewName }).click();
  await page.getByRole("menuitem", { name: `Share ${viewName} live` }).click();
  const share = page.getByRole("dialog", { name: `Share ${viewName} live` });
  await share.getByRole("button", { name: "Create live link" }).click();
  const { path, code } = await revealed(page);
  expect(path).toMatch(/^\/share\/view\/xshv_[0-9a-f]{64}$/);

  const guest = await visitor(browser);
  await guest.goto(path);
  await expect(guest.getByLabel("Access code")).toBeVisible();
  await enterCode(guest, wrong(code));
  await expect(guest.getByText("That code is not right.", { exact: false })).toBeVisible();
  await enterCode(guest, code);
  await expect(guest.getByText(title)).toBeVisible();
  await expect(guest.getByText("Updates live")).toBeVisible();
  await guest.evaluate(() => {
    (window as unknown as { p1Loaded?: boolean }).p1Loaded = true;
  });

  // A signed-in editor renames the record; the open page shows it without a reload.
  await page.goto(recordUrl);
  const renamed = `Stage Load-In Approved ${id}`;
  const titleField = page.getByRole("dialog").first().getByLabel("Title", { exact: true });
  await titleField.fill(renamed);
  await titleField.press("Enter");
  await expect(guest.getByText(renamed)).toBeVisible({ timeout: 20_000 });
  expect(
    await guest.evaluate(() => (window as unknown as { p1Loaded?: boolean }).p1Loaded === true),
  ).toBe(true);
  await guest.context().close();
});

test("a display screen follows the running order and stops when revoked", async ({
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
  for (const label of ["House to Half", "Walk-in Music Out", "Headliner On"]) {
    await page.getByLabel("Cue", { exact: true }).fill(label);
    await page.getByRole("button", { name: "Add cue" }).click();
    await expect(
      page.getByRole("list", { name: "Cues of Opening Night Running Order" }),
    ).toContainText(label);
  }
  const runUrl = page.url();

  await page.getByRole("button", { name: "Display screens" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Display screens for Opening Night Running Order",
  });
  await dialog.getByRole("button", { name: "Create screen link" }).click();
  const { path, code } = await revealed(page);
  expect(path).toMatch(/^\/share\/screen\/xscr_[0-9a-f]{64}$/);

  const screen = await visitor(browser);
  await screen.goto(path);
  await enterCode(screen, code);
  await expect(screen.getByText("Waiting for the first cue.").first()).toBeVisible();
  await expect(screen.getByText("House to Half").first()).toBeVisible();

  // The stage manager calls the first cue; the screen moves without a reload.
  await page.goto(`${runUrl}&live=1`);
  await page.getByRole("button", { name: "Call next cue" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Current cue: House to Half" }),
  ).toBeVisible();
  await expect(screen.getByText("Walk-in Music Out").first()).toBeVisible({ timeout: 20_000 });
  await expect(screen.getByText("Now")).toBeVisible();

  // Keys 1, 2 and 3 switch modes.
  await screen.keyboard.press("1");
  await expect(screen.getByRole("button", { name: "Room clock", pressed: true })).toBeVisible();
  await screen.keyboard.press("2");
  await expect(
    screen.getByRole("button", { name: "Presenter timer", pressed: true }),
  ).toBeVisible();
  await screen.keyboard.press("3");
  await expect(screen.getByRole("button", { name: "Backstage", pressed: true })).toBeVisible();

  // Revoking the link takes it off the screen on its next ping or pull.
  await page.goto(runUrl);
  await page.getByRole("button", { name: "Display screens" }).click();
  const again = page.getByRole("dialog", {
    name: "Display screens for Opening Night Running Order",
  });
  await again.getByRole("button", { name: "Revoke" }).first().click();
  await again.getByRole("button", { name: "Confirm" }).click();
  await expect(screen.getByText("This link does not work.", { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  await screen.context().close();
});
