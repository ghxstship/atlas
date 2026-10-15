import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, uniqueId } from "./support";

/**
 * A09 Places journeys on the demo tenant (supabase/seeds/0010, 0107, 0109): venues with a location
 * and the map view, spaces and zones in the tree, a capability document frozen behind its dialog, a
 * site plan with a pin placed by keyboard, comments on a venue, and every page in both themes. The
 * demo Owner drives; names carry a unique suffix so runs never collide.
 */

test.use({ reducedMotion: "reduce" });

const ORG = "demo-productions";
const DEMO_PASSWORD = `xos-demo-${"2026"}`;

async function signIn(page: Page, email = "owner@example.com") {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${ORG}/home`)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL(`**/${ORG}/home`);
}

/**
 * Waits until every horizontally scrolling region has hydrated: ScrollRegion measures its content on
 * the client and only then becomes focusable, so axe runs on the page a keyboard user meets.
 */
async function hydrated(page: Page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLElement>(".overscroll-x-contain")].every(
      (e) => e.scrollWidth <= e.clientWidth + 1 || e.tabIndex === 0,
    ),
  );
}

async function expectAccessibleInBothThemes(page: Page) {
  await hydrated(page);
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "light", url: page.url() }]);
  await page.reload();
  await hydrated(page);
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "dark", url: page.url() }]);
  await page.reload();
}

test("venues: create with a location, see it on the map and in the table, edit and comment", async ({
  page,
}) => {
  const id = uniqueId();
  const name = `Harbor Hall ${id}`;
  await signIn(page);
  await page.goto(`/${ORG}/places/venues`);
  await expect(page.getByRole("heading", { level: 1, name: "Venues" })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  await page.getByRole("link", { name: "Add venue" }).click();
  const drawer = page.getByRole("dialog", { name: "Add venue" });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel("Name").fill(name);
  await drawer.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await drawer.getByLabel("Time zone").selectOption("America/New_York");
  await drawer.getByLabel("City").fill("Miami");
  await drawer.getByLabel("Latitude").fill("25.7743");
  await drawer.getByLabel("Longitude").fill("-80.1937");
  await expectAccessible(page);
  await drawer.getByRole("button", { name: "Add venue" }).click();

  const peek = page.getByRole("dialog", { name: "Venue" });
  await expect(peek.getByRole("heading", { name })).toBeVisible();
  await expect(peek.getByText("25.77430, -80.19370")).toBeVisible();
  await expectAccessible(page);

  await peek.getByLabel("Write a comment").fill("Load-in is through the east dock.");
  await peek.getByRole("button", { name: "Post comment" }).click();
  await expect(peek.getByText("Load-in is through the east dock.")).toBeVisible();

  await peek.getByRole("link", { name: "Open full page" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("City").fill("Miami Beach");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.getByRole("link", { name: "Back to venues" }).click();

  await page.getByRole("radio", { name: "Map" }).click();
  await expect(page).toHaveURL(/view=map/);
  await expect(page.getByText(name).first()).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("radio", { name: "Table" }).click();
  await expect(page.getByRole("gridcell", { name }).first()).toBeVisible();
  await expectAccessible(page);

  // An invalid location is refused with a field error that names the fix.
  await page.goto(`/${ORG}/places/venues?create=1`);
  const again = page.getByRole("dialog", { name: "Add venue" });
  await again.getByLabel("Name").fill(`Bad ${id}`);
  await again.getByLabel("Latitude").fill("120");
  await again.getByLabel("Longitude").fill("10");
  await again.getByRole("button", { name: "Add venue" }).click();
  await expect(again.getByText("Latitude runs from -90 to 90.")).toBeVisible();
});

test("spaces and zones: add a space and a zone, see them in the tree, archive and restore", async ({
  page,
}) => {
  const id = uniqueId();
  await signIn(page);
  await page.goto(`/${ORG}/places/spaces-and-zones`);
  await expect(page.getByRole("heading", { level: 1, name: "Spaces and Zones" })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  await page.getByRole("link", { name: "Add space" }).click();
  const spaceDrawer = page.getByRole("dialog", { name: "Add space" });
  await spaceDrawer.getByLabel("Name").fill(`Deck ${id}`);
  await spaceDrawer.getByLabel("Occupant capacity").fill("800");
  await expectAccessible(page);
  await spaceDrawer.getByRole("button", { name: "Add space" }).click();
  await expect(
    page.getByRole("dialog", { name: "Space" }).getByRole("heading", { name: `Deck ${id}` }),
  ).toBeVisible();

  await page.goto(`/${ORG}/places/spaces-and-zones?create=zone`);
  const zoneDrawer = page.getByRole("dialog", { name: "Add zone" });
  const code = `Z${id.slice(-6).toUpperCase()}`;
  await zoneDrawer.getByLabel("Zone code").fill(code);
  await zoneDrawer.getByLabel("Name").fill(`Gate ${id}`);
  await zoneDrawer.getByRole("button", { name: "Add zone" }).click();
  const zonePeek = page.getByRole("dialog", { name: "Zone" });
  await expect(zonePeek.getByRole("heading", { name: `Gate ${id}` })).toBeVisible();
  await zonePeek.getByRole("button", { name: "Archive" }).click();
  await expect(zonePeek.getByText("This is archived. Restore it to use it again.")).toBeVisible();
  await zonePeek.getByRole("button", { name: "Restore" }).click();
  await expect(zonePeek.getByRole("button", { name: "Archive" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(`/${ORG}/places/spaces-and-zones?view=tree`);
  await expect(page.getByRole("tree")).toBeVisible();
  await expect(page.getByRole("treeitem", { name: new RegExp(`Deck ${id}`) })).toBeVisible();
  await expectAccessible(page);

  // A duplicate zone code in the same venue is refused.
  await page.goto(`/${ORG}/places/spaces-and-zones?create=zone`);
  const dup = page.getByRole("dialog", { name: "Add zone" });
  await dup.getByLabel("Zone code").fill(code);
  await dup.getByLabel("Name").fill("Duplicate");
  await dup.getByRole("button", { name: "Add zone" }).click();
  await expect(dup.getByText("Another item already uses this name or code.")).toBeVisible();
});

test("capability documents: add, freeze behind the dialog, and refuse edits once frozen", async ({
  page,
}) => {
  const id = uniqueId();
  const title = `Tech Pack ${id}`;
  await signIn(page);
  await page.goto(`/${ORG}/places/capability-documents?create=1`);
  const drawer = page.getByRole("dialog", { name: "Add document" });
  await drawer.getByLabel("Title").fill(title);
  await drawer.getByLabel("Stored at").fill(`https://docs.example.com/${id}.pdf`);
  await drawer.getByLabel("Valid from").fill("2026-01-01");
  await drawer.getByRole("button", { name: "Add document" }).click();
  const peek = page.getByRole("dialog", { name: "Capability document" });
  await expect(peek.getByRole("heading", { name: title })).toBeVisible();
  await expectAccessible(page);
  await peek.getByRole("button", { name: "Freeze" }).click();
  const confirm = page.getByRole("dialog", { name: `Freeze ${title}?` });
  await expect(confirm).toBeVisible();
  await expectAccessible(page);
  await confirm.getByRole("button", { name: "Freeze document" }).click();
  await expect(peek.getByText("This document is frozen.")).toBeVisible();
  await expect(peek.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto(`/${ORG}/places/capability-documents`);
  await expectAccessibleInBothThemes(page);
});

test("site plans: add a plan to the demo project and place a pin by keyboard", async ({ page }) => {
  const id = uniqueId();
  const title = `Ground Plan ${id}`;
  await signIn(page);
  await page.goto(`/${ORG}/places/site-plans?create=1`);
  const drawer = page.getByRole("dialog", { name: "Add site plan" });
  await drawer.getByLabel("Title").fill(title);
  await drawer.getByLabel("Drawing").fill(`plans/${id}.png`);
  await drawer.getByRole("button", { name: "Add site plan" }).click();
  const peek = page.getByRole("dialog", { name: "Site plan" });
  await expect(peek.getByRole("heading", { name: title })).toBeVisible();
  await peek.getByLabel("Label").fill("FOH Mix");
  await peek.getByLabel("Across (%)").fill("50");
  await peek.getByLabel("Down (%)").fill("62.5");
  await peek.getByRole("button", { name: "Place pin" }).click();
  await expect(peek.getByText("1. FOH Mix at 50% across, 62.5% down")).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await page.goto(`/${ORG}/places/site-plans`);
  await expectAccessibleInBothThemes(page);
  await page.getByRole("radio", { name: "Site plan" }).click();
  await expectAccessible(page);
});

test("reconciliation: an UNKNOWN claim on a critical requirement is a gate 3 gap, a documented one meets it", async ({
  page,
}) => {
  const id = uniqueId();
  await signIn(page);
  await page.goto(`/${ORG}/p/NWS/scope`);
  const panel = page.getByRole("region", { name: "Requirements and Capability" });
  await expect(panel).toBeVisible();
  await expectAccessibleInBothThemes(page);

  const requirements = page.getByRole("region", { name: "Requirements", exact: true });
  await requirements.getByRole("combobox", { name: "Category" }).fill("Production Leadership");
  await page.getByRole("option", { name: /Production Leadership 0000\.01\.01/ }).click();
  await requirements.getByLabel("What is required").fill(`Show caller on headset ${id}`);
  await requirements.getByLabel("Critical: an Unknown here is a gate 3 gap").check();
  await requirements.getByRole("button", { name: "Add requirement" }).click();
  await expect(panel.getByText(`Show caller on headset ${id}`).first()).toBeVisible();

  await panel.getByRole("button", { name: "Reconcile now" }).click();
  await expect(panel.getByText(/gate 3 gaps?$/).first()).toBeVisible();
  await hydrated(page);
  await expectAccessible(page);

  const capabilities = page.getByRole("region", { name: "Capabilities", exact: true });
  await capabilities.getByRole("combobox", { name: "Category" }).fill("Production Leadership");
  await page.getByRole("option", { name: /Production Leadership 0000\.01\.01/ }).click();
  await capabilities.getByLabel("What is provided").fill(`Venue stage manager ${id}`);
  await capabilities.getByLabel("Claim strength").selectOption("DOCUMENTED");
  await capabilities.getByRole("button", { name: "Add capability" }).click();
  await expect(panel.getByText(`Venue stage manager ${id}`).first()).toBeVisible();
  await panel.getByRole("button", { name: "Reconcile now" }).click();
  // A documented capability on the same category now meets the requirement.
  await expect(
    panel.getByRole("row", { name: new RegExp(`Show caller on headset ${id}`) }),
  ).toContainText("Met");
  await hydrated(page);
  await expectAccessible(page);
});
