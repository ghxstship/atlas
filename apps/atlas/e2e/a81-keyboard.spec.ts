import type { Page } from "@playwright/test";
import { expect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A81 navigation and keyboard (RRR-126; findings A65-007 and A65-024): the global Create menu and C
 * (Section 4.10, 11.2), G then a letter (11.2), rebinding in Personal settings with conflict and
 * reserved-key checks (11.7), and hiding and reordering the sidebar by keyboard with Reset to role
 * default (4.5.2). Each journey signs up a new person with their own org, so nothing it changes
 * reaches another journey. Keys are pressed only once html[data-shell-ready] says the shell's key
 * handler listens.
 */
test.use({ reducedMotion: "reduce" });
// Sign-up, a new org and a first visit to each page take a while under next dev.
test.describe.configure({ timeout: 180_000 });

async function newOrg(page: Page, label: string): Promise<string> {
  const id = uniqueId();
  const slug = `${label}-${id}`;
  await signUp(page, { name: "Kim Keys", email: testEmail(label, id) });
  await createOrganization(page, { name: `Keys ${id}`, slug });
  return slug;
}

/** Waits until the page settles and the shell answers keys, with focus on the page, not a field. */
async function ready(page: Page) {
  // In development a first visit compiles the route and Fast Refresh reattaches the key handler.
  await page.waitForLoadState("networkidle");
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  await page.locator("#content").focus();
}

async function openReady(page: Page, path: string) {
  await page.goto(path);
  await ready(page);
}

/** The command menu's search field. */
function commandSearch(page: Page) {
  return page.getByRole("dialog", { name: "Command menu" }).getByRole("combobox");
}

test("C opens the Create menu with this page's kind first, and Enter starts its create flow", async ({
  page,
}) => {
  const slug = await newOrg(page, "create");
  await openReady(page, `/${slug}/projects/all`);
  await page.keyboard.press("c");
  const menu = page.getByRole("dialog", { name: "Create" });
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await expect(menu.getByRole("option").first()).toHaveText(/^Project/);
  await expectAccessible(page);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/${slug}/projects/all\\?create=1$`));
  await expect(page.getByRole("dialog", { name: "New project" })).toBeVisible();

  // The sidebar's Create entry opens the same menu, ordered for the page it is on.
  await openReady(page, `/${slug}/finance/budgets`);
  await page.locator("[data-create-trigger]").click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option").first()).toHaveText(/^Budget/);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("G then a letter goes to a section with a visible hint, and typing never does", async ({
  page,
}) => {
  const slug = await newOrg(page, "gonav");
  await openReady(page, `/${slug}/home`);
  await page.keyboard.press("g");
  const hint = page.locator("[data-go-hint]");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("Projects");
  await expectAccessible(page);
  // Esc cancels the sequence; the next G starts again.
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  await page.keyboard.press("g");
  await page.keyboard.press("p");
  await expect(page).toHaveURL(new RegExp(`/${slug}/projects$`));
  await expect(hint).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();

  await ready(page);
  await page.keyboard.press("g");
  await page.keyboard.press("i");
  await expect(page).toHaveURL(new RegExp(`/${slug}/inbox$`));
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();

  // In the command menu's search field the letters are text, and the menu hints each section's keys.
  await ready(page);
  await page.keyboard.press("ControlOrMeta+k");
  const search = commandSearch(page);
  await expect(search).toBeVisible({ timeout: 15_000 });
  await page.keyboard.type("gh");
  await expect(search).toHaveValue("gh");
  await expect(hint).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/${slug}/inbox$`));
  await search.fill("Finance");
  await expect(page.getByRole("option", { name: /^Finance/ }).first()).toContainText("G");
  await page.keyboard.press("Escape");
});

test("a person rebinds a shortcut, and conflicts and screen reader keys are refused", async ({
  page,
}) => {
  const slug = await newOrg(page, "rebind");
  await openReady(page, `/${slug}/me/keyboard-shortcuts`);
  const editor = page.getByRole("region", { name: "Change shortcuts", exact: true });
  const row = editor.getByRole("row", { name: /Go to Projects/ });
  await expect(row).toContainText("G");

  await row.getByRole("button", { name: "Change" }).click();
  await expect(row.getByRole("button", { name: "Press Keys" })).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(row).toContainText("G H already does Go to Home.");

  await row.getByRole("button", { name: "Change" }).click();
  await expect(row.getByRole("button", { name: "Press Keys" })).toBeVisible();
  await page.keyboard.press("Insert");
  await expect(row).toContainText("Insert belongs to screen readers.");

  await row.getByRole("button", { name: "Change" }).click();
  await expect(row.getByRole("button", { name: "Press Keys" })).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("j");
  await expect(editor.getByRole("status")).toHaveText("Go to Projects now uses G J.");
  await expect(row.getByRole("button", { name: "Reset" })).toBeVisible();
  await expectAccessible(page);

  // The new keys work at once in the shell, and Help's sheet shows them.
  await openReady(page, `/${slug}/home`);
  await page.keyboard.press("g");
  await page.keyboard.press("j");
  await expect(page).toHaveURL(new RegExp(`/${slug}/projects$`));
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await ready(page);
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Help" });
  await expect(help.getByRole("term").filter({ hasText: "Go to Projects" })).toBeVisible({
    timeout: 15_000,
  });
  await expectAccessible(page);
  await page.keyboard.press("Escape");

  // Reset returns the default.
  await openReady(page, `/${slug}/me/keyboard-shortcuts`);
  await editor
    .getByRole("row", { name: /Go to Projects/ })
    .getByRole("button", { name: "Reset" })
    .click();
  await expect(editor.getByRole("status")).toHaveText(
    "Go to Projects uses its default keys again.",
  );
});

test("a person hides a sidebar item and moves a group by keyboard, then resets to the role default", async ({
  page,
}) => {
  const slug = await newOrg(page, "sidebar");
  await page.goto(`/${slug}/me/preferences`);
  const editor = page.getByRole("region", { name: "Sidebar", exact: true });
  await editor.getByRole("checkbox", { name: "Show Advancing in the sidebar" }).uncheck();

  // Space picks up, the arrows move, Space drops; a screen reader hears each step.
  const handle = editor.getByRole("button", { name: "Move Commercial group" });
  await handle.focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByText("Commercial group picked up, position 4 of 5.", { exact: false }),
  ).toBeAttached();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Space");
  await expect(page.getByText("Commercial group dropped at position 1 of 5.")).toBeAttached();
  await expect(handle).toBeFocused();
  await expectAccessible(page);
  await editor.getByRole("button", { name: "Save sidebar" }).click();
  await expect(editor.getByRole("status")).toHaveText("Your sidebar is saved.");

  // The sidebar follows; the hidden item stays in the command menu.
  const main = page.getByRole("navigation", { name: "Main" });
  await expect(main.locator("h2 button").first()).toHaveText("Commercial");
  await expect(main.locator(`a[href="/${slug}/advancing"]`)).toHaveCount(0);
  await ready(page);
  await page.keyboard.press("ControlOrMeta+k");
  await commandSearch(page).fill("Advancing");
  await expect(page.getByRole("option", { name: /Advancing/ }).first()).toBeVisible();
  await page.keyboard.press("Escape");

  await editor.getByRole("button", { name: "Reset to role default" }).click();
  await expect(editor.getByRole("status")).toHaveText(
    "Your sidebar is back to the default for your role.",
  );
  await expect(main.locator("h2 button").first()).toHaveText("Production");
  await expect(main.locator(`a[href="/${slug}/advancing"]`)).toHaveCount(1);
});
