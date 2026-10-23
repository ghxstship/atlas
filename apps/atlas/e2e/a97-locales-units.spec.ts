import { expect, test, type Page } from "./engine-test";
import { expectAccessibleInBothThemes, ORG, signIn } from "./a16-support";

/**
 * A97 (RRR-142, ADR 0053), Section 15 on the demo tenant:
 * - a Beta locale picked from the account menu is marked Beta, sets the document language, and reads en-US for
 *   every key its catalog lacks, so no raw key shows;
 * - locale.units switches the weather board between metric and the project jurisdiction's imperial units;
 * - me.time_zone_display switches schedule times from the event's zone to the person's own, labeled.
 * Every setting it changes is put back, since the demo producer is shared with other journeys.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
expect.configure({ timeout: 20_000 });

/** The seeded Northwind Summer Series project (seed 0107): Miami-Dade, so imperial by jurisdiction. */
const DEMO_PROJECT = "01920000-0000-7000-8000-000000001001";

/** A catalog key such as `shell.chrome.search` rendered instead of its message. */
const RAW_KEY =
  /\b(shell|nav|settings|home|ui|projects|work|finance|crew|platform|people|schedule|help|status)\.[A-Za-z][A-Za-z0-9-]*\.[A-Za-z0-9.-]+\b/;

async function expectNoRawKeys(page: Page) {
  const text = await page.locator("body").innerText();
  expect(text.match(RAW_KEY)?.[0] ?? null).toBeNull();
}

async function chooseLanguage(page: Page, name: string) {
  await page.getByRole("button", { name: "Account" }).first().click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

/** Opens the "More fields" part of a settings form when the field sits there. */
async function reveal(page: Page, field: ReturnType<Page["locator"]>) {
  if (await field.isVisible()) return;
  const form = page.getByRole("form", { name: "Settings on this page" });
  await form.getByRole("button", { name: "More fields" }).first().click();
  await expect(field).toBeVisible();
}

/** Sets one personal preference on Preferences, if it is not set to that value already. */
async function setPreference(page: Page, label: string, value: string) {
  await page.goto(`/${ORG}/me/preferences`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  const form = page.getByRole("form", { name: "Settings on this page" });
  const select = form.getByLabel(label, { exact: true });
  if ((await select.inputValue()) === value) return;
  await reveal(page, select);
  await select.selectOption(value);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
}

/** Removes the person's own value of a preference (back to the org's value or the default), if they set one. */
async function clearPreference(page: Page, label: string) {
  await page.goto(`/${ORG}/me/preferences`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  const form = page.getByRole("form", { name: "Settings on this page" });
  const field = form.locator("li").filter({ has: page.getByLabel(label, { exact: true }) });
  const clear = field.getByRole("button", {
    name: /^(Use the inherited value|Reset to the platform default)$/,
  });
  if ((await clear.count()) === 0) return;
  await reveal(page, clear.first());
  await clear.first().click();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
}

test("a Beta locale from the picker reads en-US where it has no translation, never a raw key", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");
  try {
    await page.goto(`/${ORG}/home`);
    await page.getByRole("button", { name: "Account" }).first().click();
    // Every Beta locale says so in its name.
    for (const beta of [
      "Français (Beta)",
      "Deutsch (Beta)",
      "Italiano (Beta)",
      "Português (Brasil) (Beta)",
      "日本語 (Beta)",
    ]) {
      await expect(page.getByRole("menuitem", { name: beta, exact: true })).toBeVisible();
    }
    await page.keyboard.press("Escape");

    await chooseLanguage(page, "Français (Beta)");
    await expect(page.locator("html")).toHaveAttribute("lang", "fr-FR");
    // Nothing is machine translated yet: the copy is en-US, key by key, on every page visited.
    for (const path of ["home", "my-work", `p/NWS/overview`, "me/preferences"]) {
      await page.goto(`/${ORG}/${path}`);
      await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
      await expect(page.locator("html")).toHaveAttribute("lang", "fr-FR");
      await expectNoRawKeys(page);
    }
    await expect(page.getByRole("heading", { level: 1, name: "Preferences" })).toBeVisible();
    await expect(page.getByLabel("Language", { exact: true })).toHaveValue("fr-FR");
    await expectAccessibleInBothThemes(page);
  } finally {
    await page.goto(`/${ORG}/home`);
    await chooseLanguage(page, "English (US)");
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  }
});

test("locale.units switches the weather board between metric and the jurisdiction's imperial", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");
  const weather = `/${ORG}/site-ops/weather?project=${DEMO_PROJECT}`;
  try {
    // By default units follow the project's jurisdiction: Miami-Dade measures in mph and miles.
    await setPreference(page, "Units", "jurisdiction");
    await page.goto(weather);
    const thresholds = page.getByRole("region", { name: "Thresholds" }).first();
    await expect(thresholds).toContainText("mph");
    await expect(page.getByLabel("Hazard").first()).toContainText("Wind gusts (mph)");

    await setPreference(page, "Units", "metric");
    await page.goto(weather);
    await expect(thresholds).toContainText("km/h");
    await expect(thresholds).not.toContainText("mph");
    await expect(page.getByLabel("Hazard").first()).toContainText("Wind gusts (km/h)");
    await expectAccessibleInBothThemes(page);
  } finally {
    await clearPreference(page, "Units");
  }
});

/** Locks or unlocks the org's time zone on Settings, Localization (the demo org locks it at New York). */
async function setOrgZoneLock(page: Page, locked: boolean) {
  await page.goto(`/${ORG}/settings/localization`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  const form = page.getByRole("form", { name: "Settings on this page" });
  const zone = form.locator("li").filter({ has: page.getByLabel("Time zone", { exact: true }) });
  const lock = zone.getByRole("button", { name: "Lock value" });
  if ((await lock.getAttribute("aria-pressed")) === String(locked)) return;
  await reveal(page, lock);
  await lock.click();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
}

test("me.time_zone_display shows shift times in the event's zone or the person's own, labeled", async ({
  page,
}) => {
  // The owner may unlock the org's time zone for the run; the lock is put back at the end.
  await signIn(page, "owner@example.com");
  const shifts = `/${ORG}/crew/shifts?view=table&week=2027-03-08`;
  try {
    await setOrgZoneLock(page, false);
    await setPreference(page, "Time zone", "Asia/Tokyo");
    await setPreference(page, "Show schedule times in", "event");
    await page.goto(shifts);
    const table = page.getByRole("grid").first();
    // The demo shifts are in New York; March 8, 2027 is before the change to daylight time.
    await expect(table).toContainText("EST");

    await setPreference(page, "Show schedule times in", "viewer");
    await page.goto(shifts);
    await expect(table).toContainText("GMT+9");
    await expect(table).not.toContainText("EST");
    await expectAccessibleInBothThemes(page);
  } finally {
    await clearPreference(page, "Show schedule times in");
    await clearPreference(page, "Time zone");
    await setOrgZoneLock(page, true);
  }
});
