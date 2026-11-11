import type { Locator } from "@playwright/test";
import { expect, test } from "./engine-test";
import { expectAccessibleInBothThemes, ORG, settled, signIn } from "./operations-support";

/**
 * The shell's global `?peek={recordKey}` (Section 4.5.3): on a page that does not peek its own rows,
 * the record opens in the side peek with the sections of its full page (Section 11.2 item 4), Open
 * full goes to the record page, closing removes the parameter, a collection keeps its own rows (peek
 * or full page, however slow) and hands over a key it has no row for (a record key from elsewhere, a
 * stale link), and a key for no readable record says so. Runs on the demo tenant seed (NWS-12 is the
 * Production Meeting record, NWS-3 the main truss, MH-001 an asset unit).
 */

test.use({ reducedMotion: "reduce" });

test("a record opens in the side peek from any route and closes back to the page", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/home?peek=NWS-12`);
  const peek = page.getByRole("dialog", { name: /Production Meeting/ });
  await expect(peek).toBeVisible();
  await expect(peek.getByText("NWS-12")).toBeVisible();
  await settled(page);

  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/home$`));

  await page.goto(`/${ORG}/activity?peek=NWS-12`);
  await expect(page.getByRole("dialog", { name: /Production Meeting/ })).toBeVisible();
  await page.getByRole("button", { name: "Open full page" }).click();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/r/NWS-12$`));
});

test("the shell's peek, a work peek and the full page show the same record sections", async ({
  page,
}) => {
  // Section 11.2 item 4: activity and comments, and related records, wherever the record opens.
  // NWS-3 (Hang the main truss) waits on NWS-2 (the stage deck) and holds up NWS-4 (the focus).
  await signIn(page, "producer@example.com");
  const note = `Shackles checked ${Date.now()}`;
  const sections = async (scope: Locator) => {
    await expect(scope.getByRole("region", { name: "Comments" })).toBeVisible();
    await expect(scope.getByRole("region", { name: "Attachments" })).toBeVisible();
    const related = scope.getByRole("region", { name: "Related records" });
    await expect(related).toContainText("Install the stage deck");
    await expect(related).toContainText("Focus the wash lights");
    await expect(scope.getByRole("region", { name: "Comments" })).toContainText(note);
  };

  await page.goto(`/${ORG}/home?peek=NWS-3`);
  const peek = page.getByRole("dialog", { name: /Hang the main truss/ });
  await expect(peek).toBeVisible();
  await expect(peek.getByRole("region", { name: "Recent activity" })).toBeVisible();
  // A comment posted in the shell's peek shows there at once: the peek reads the record again.
  await peek.getByLabel("Write a comment").fill(note);
  await peek.getByRole("button", { name: "Post comment" }).click();
  await sections(peek);
  await settled(page);

  await page.goto(`/${ORG}/work/all-records?peek=NWS-3`);
  const workPeek = page.getByRole("dialog", { name: /Hang the main truss/ });
  await expect(workPeek).toBeVisible();
  await sections(workPeek);
  await expect(page.getByTestId(/^shell-peek-/)).toHaveCount(0);

  await page.goto(`/${ORG}/r/NWS-3`);
  await expect(page.getByRole("heading", { level: 1, name: "Hang the main truss" })).toBeVisible();
  await sections(page.locator("main"));
  await expectAccessibleInBothThemes(page);
});

test("a collection's full record page keeps the shell's peek closed", async ({ page }) => {
  await signIn(page, "producer@example.com");
  // `?peek` here is the collection's own row (an asset tag), which it renders as its full page.
  await page.goto(`/${ORG}/assets/units?peek=MH-001&full=1`);
  await expect(page.getByRole("heading", { name: /MH-001/ })).toBeVisible();
  // Leave the shell time it would need to open the key, had it taken it from the page.
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId(/^shell-peek-/)).toHaveCount(0);
  await expect(page.getByText("is not a record you can open here")).toHaveCount(0);
});

test("a row opened by a click stays the collection's while its peek is slow to load", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/assets/units?view=list`);
  await expect(page.getByRole("heading", { level: 1, name: "Units" })).toBeVisible();
  await settled(page);
  // Hold the server render of the peek for 1.5 s, as on a slow network: the URL moves to `?peek`
  // under the section's loading state long before the page's own panel arrives.
  await page.route(
    (url) => url.pathname === `/${ORG}/assets/units` && url.searchParams.has("peek"),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.fallback();
    },
  );
  await page
    .getByRole("row")
    .filter({ hasText: "MH-001" })
    .getByRole("button", { name: "Open" })
    .first()
    .click();
  await expect(page.getByRole("dialog", { name: /MH-001/ })).toBeVisible();
  await expect(page.getByTestId(/^shell-peek-/)).toHaveCount(0);
  await expect(page.getByText("is not a record you can open here")).toHaveCount(0);
});

test("a collection hands the shell a key it has no row for", async ({ page }) => {
  await signIn(page, "owner@example.com");
  // NWS-12 is a work record, not a vendor: the directory hands it over and the shell opens it.
  await page.goto(`/${ORG}/vendors/directory?peek=NWS-12`);
  const peek = page.getByRole("dialog", { name: /Production Meeting/ });
  await expect(peek).toBeVisible();
  await expect(peek.getByText("NWS-12")).toBeVisible();
  await settled(page);
  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/vendors/directory$`));
});

test("a collection that reads its rows by id hands over a record key", async ({ page }) => {
  await signIn(page, "owner@example.com");
  // Timesheets read the peeked row by UUID, which Postgres refuses for NWS-12 (22P02): the page
  // counts that as no row and hands the key over instead of failing into its error boundary.
  await page.goto(`/${ORG}/crew/timesheets?peek=NWS-12`);
  const peek = page.getByRole("dialog", { name: /Production Meeting/ });
  await expect(peek).toBeVisible();
  await expect(peek.getByText("NWS-12")).toBeVisible();
  await settled(page);
  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/crew/timesheets$`));
});

test("advancing hands the shell a key that is no packet id", async ({ page }) => {
  await signIn(page, "producer@example.com");
  // Packets keep their 404 for a packet id they have no packet for, but NWS-12 is no packet id at
  // all (a work record's key): the page hands it over and the shell opens the record.
  await page.goto(`/${ORG}/advancing/packets?peek=NWS-12`);
  await expect(page.getByRole("heading", { level: 1, name: "Packets" })).toBeVisible();
  const peek = page.getByRole("dialog", { name: /Production Meeting/ });
  await expect(peek).toBeVisible();
  await settled(page);
  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/advancing/packets$`));
});

test("a collection hands the shell a stale key, which names the problem", async ({ page }) => {
  await signIn(page, "owner@example.com");
  // NWS-99999 names no record (a link to one since deleted): All records has no row for it, so it
  // hands the key over instead of showing the list with nothing open.
  await page.goto(`/${ORG}/work/all-records?peek=NWS-99999`);
  await expect(page.getByRole("heading", { level: 1, name: "All Records" })).toBeVisible();
  const missing = page.getByTestId("shell-peek-missing");
  await expect(missing).toContainText("NWS-99999 is not a record you can open here");
  await settled(page);
  await missing.getByRole("button", { name: "Close" }).click();
  await expect(missing).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/work/all-records$`));
});

test("a key for no readable record names the problem and closes", async ({ page }) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/home?peek=NWS-99999`);
  const missing = page.getByTestId("shell-peek-missing");
  await expect(missing).toContainText("NWS-99999 is not a record you can open here");
  await settled(page);
  await missing.getByRole("button", { name: "Close" }).click();
  await expect(missing).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/home$`));
});

test("the command menu finds a record by key and opens it in the side peek (A59-015)", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/home`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  await settled(page);
  await page.keyboard.press("ControlOrMeta+k");
  const menu = page.getByRole("dialog").filter({ has: page.getByRole("combobox") });
  await expect(menu).toBeVisible({ timeout: 15_000 });

  // The common actions arrive from the server; one that opens a page shows that page's G shortcut.
  const openInbox = menu.getByRole("option", { name: /Open Inbox/ });
  await expect(openInbox).toBeVisible();
  await expect(openInbox.locator("kbd")).toHaveText(["G", "I"]);

  await page.keyboard.type("NWS-12");
  const hit = menu.getByRole("option", { name: /Production Meeting/ });
  await expect(hit).toBeVisible();
  await expect(hit).toContainText("NWS-12");
  await hit.click();
  await expect(page.getByRole("dialog", { name: /Production Meeting/ })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/home\\?peek=NWS-12$`));
});
