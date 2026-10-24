import { expect, test, type Page } from "./engine-test";
import { expectAccessibleInBothThemes, ORG, settled, signIn } from "./operations-support";

/**
 * A31 journeys (Section 20.2, RRR-33) on the demo tenant seed (0010, 0107 and 0231):
 *   68  shifts open as a resource schedule; a filter set in table view survives a switch to board
 *       and map; a collection without dates never offers calendar; saved views save, share, default
 *   69  the `?` key opens help for the current page; a support request with consented diagnostics
 *       reaches the Organization queue, where an admin answers it
 * Every screen is checked with axe in both themes, and in right-to-left where it matters.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
expect.configure({ timeout: 20_000 });

async function viewSwitcher(page: Page, name: RegExp) {
  return page.getByRole("radiogroup", { name });
}

test("journey 68: views keep their filters and a view that does not fit never appears", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");

  // Shifts open as a resource schedule (the registry default for shifts in Atlas).
  await page.goto(`/${ORG}/crew/shifts`);
  await expect(page.getByRole("radio", { name: "Schedule", exact: true })).toBeChecked();

  // A filter set in table view survives a switch to board and map.
  await page.goto(`/${ORG}/safety/incidents?view=table&project=NWS`);
  const switcher = await viewSwitcher(page, /views/i);
  await switcher.getByRole("radio", { name: "Board" }).click();
  await page.waitForURL(/view=board/);
  expect(new URL(page.url()).searchParams.get("project")).toBe("NWS");
  await (await viewSwitcher(page, /views/i)).getByRole("radio", { name: "Map" }).click();
  await page.waitForURL(/view=map/);
  expect(new URL(page.url()).searchParams.get("project")).toBe("NWS");

  // Incidents have no date range view: the switcher never offers calendar.
  await expect(
    (await viewSwitcher(page, /views/i)).getByRole("radio", { name: "Calendar" }),
  ).toHaveCount(0);
  await expectAccessibleInBothThemes(page);
});

test("journey 68: save a view, open it by default and remove it", async ({ page }) => {
  await signIn(page, "producer@example.com");
  const name = `Board view ${Date.now().toString(36)}`;
  await page.goto(`/${ORG}/logistics/marshalling-yard-log?view=board&q=FL`);

  await page.getByRole("button", { name: /Saved views/ }).click();
  await page.getByRole("menuitem", { name: "Save current view" }).click();
  const dialog = page.getByRole("dialog", { name: "Save current view" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Everyone in the organization").check();
  await settled(page);
  await dialog.getByRole("button", { name: "Save view" }).click();
  await expect(dialog).toHaveCount(0);

  // The saved view is the one on screen; make it the page default.
  await page.getByRole("button", { name }).click();
  await page.getByRole("menuitem", { name: `Open ${name} by default` }).click();
  await expect(page.getByRole("status").filter({ hasText: "now opens by default" })).toHaveCount(1);

  // Arriving without filters opens the default view.
  await page.goto(`/${ORG}/logistics/marshalling-yard-log`);
  await page.waitForURL(/view=board/);
  expect(new URL(page.url()).searchParams.get("q")).toBe("FL");

  // Delete it; the page returns to its own default afterwards.
  await page.getByRole("button", { name }).click();
  await page.getByRole("menuitem", { name: `Delete ${name}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete view" }).click();
  await page.goto(`/${ORG}/logistics/marshalling-yard-log`);
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).searchParams.get("q")).toBeNull();
});

test("journey 69: ? opens help for the page, and a request with diagnostics reaches the admins", async ({
  page,
  browser,
}) => {
  await signIn(page, "field@example.com");
  const subject = `Scanner question ${Date.now().toString(36)}`;
  await page.goto(`/${ORG}/credentials/access-grid`);
  // The shortcut works once the shell's key handler has loaded and attached it.
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Help" });
  await expect(help.getByRole("button", { name: /Credentials and the Access Grid/ })).toBeVisible();
  await settled(page);

  // Read the page's article, then come back.
  await help.getByRole("button", { name: /Credentials and the Access Grid/ }).click();
  await expect(help.getByRole("heading", { name: "Access Grid", exact: true })).toBeVisible();
  await help.getByRole("button", { name: "Back to help" }).click();

  // Contact support with consented diagnostics.
  await help.getByRole("button", { name: "Contact support", exact: true }).click();
  await help.getByLabel("Subject").fill(subject);
  await help
    .getByLabel("What happened, and what do you need?")
    .fill("Zone B denies every Crew wristband.");
  await help.getByLabel("Attach diagnostics").check();
  await settled(page);
  await help.getByRole("button", { name: "Send request" }).click();
  await expect(help.getByText(/Request SUP-\d+ sent/)).toBeVisible();

  // The admin sees it in the Organization queue with the diagnostics, and answers.
  const admin = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signIn(admin, "admin@example.com");
  await admin.goto(`/${ORG}/settings/help-and-support`);
  await expect(admin.getByRole("heading", { name: "Support requests" })).toBeVisible();
  await expectAccessibleInBothThemes(admin);
  await admin.getByRole("gridcell", { name: subject }).dblclick();
  const drawer = admin.getByRole("dialog", { name: new RegExp(subject) });
  await expect(drawer.getByText("/demo-productions/credentials/access-grid")).toBeVisible();
  await drawer.getByLabel("Reply").fill("Zone B was archived. It is restored now.");
  await drawer.getByRole("button", { name: "Send reply" }).click();
  await expect(drawer.getByText("Zone B was archived. It is restored now.")).toBeVisible();
  await settled(admin);

  // The requester follows it in Me, Account.
  await page.goto(`/${ORG}/me/account`);
  await expect(page.getByRole("heading", { name: "My support requests" })).toBeVisible();
  await expect(page.getByText(subject)).toBeVisible();
  await expectAccessibleInBothThemes(page);
});

test("tours are offered once, run by keyboard, and replay from preferences", async ({ page }) => {
  await signIn(page, "owner@example.com");
  await page.goto(`/${ORG}/me/preferences`);
  await expect(page.getByRole("heading", { name: "Tours and tips" })).toBeVisible();
  await expectAccessibleInBothThemes(page);
  const replay = page.getByRole("link", { name: "Replay" }).first();
  await replay.click();
  await page.waitForURL(/tour=atlas\.getting-started/);
  const tour = page.getByRole("region", { name: "Guided tour" });
  await expect(tour).toBeFocused();
  await expect(tour.getByText("Step 1 of 4")).toBeVisible();
  await settled(page);
  for (let i = 0; i < 3; i += 1) await tour.getByRole("button", { name: "Next" }).click();
  await tour.getByRole("button", { name: "Finish" }).click();
  await expect(tour).toHaveCount(0);
  // Progress is saved in the background; let the last save land before leaving the page.
  await page.waitForLoadState("networkidle");
  await page.goto(`/${ORG}/me/preferences`);
  await expect(page.getByText("Completed").first()).toBeVisible();
});

test("journey 69: a gate chip shows its canon definition on hover and on focus", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/p/NWS/gates`);
  // A hover that lands before the page hydrates opens nothing, and the pointer never re-enters.
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  const chip = page.locator("h2 span[tabindex='0']").first();
  await chip.hover();
  const card = page.locator("[data-radix-popper-content-wrapper]").first();
  await expect(card).toBeVisible();
  await expect(card.locator("p").nth(1)).not.toBeEmpty();
  await settled(page);
  await page.mouse.move(0, 0);
  await chip.focus();
  await expect(card).toBeVisible();
});

test("help panel and saved views work right to left at phone width", async ({ page }) => {
  // The pseudo-locales (gate 16) ship only in development builds (i18n/negotiate.ts); a run against
  // a production build sets E2E_PRODUCTION_BUILD=1 and covers this journey on next dev instead.
  test.skip(
    process.env["E2E_PRODUCTION_BUILD"] === "1",
    "ar-XB is offered only by development builds",
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, "producer@example.com");
  await page.context().addCookies([{ name: "xos-locale", value: "ar-XB", url: page.url() }]);
  await page.goto(`/${ORG}/logistics/shipments?view=table`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await settled(page);
  await page.locator("button[data-help-trigger]").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await settled(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
