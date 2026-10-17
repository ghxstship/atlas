import { expect, test } from "@playwright/test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * Settings and identity (A30): every settings and personal settings page renders axe clean for
 * an Owner, a locked org time zone cannot be overridden by a workspace and says where the value
 * comes from (journey 63), and a module turned off leaves navigation (journey 51).
 */
const ORG_PAGES = [
  "general",
  "organization-profile",
  "legal-entities-and-fiscal",
  "members",
  "roles-and-capabilities",
  "teams",
  "workspaces",
  "security",
  "access-reviews",
  "white-label",
  "modules",
  "views-and-defaults",
  "numbering",
  "time-and-attendance",
  "scheduling",
  "payroll-and-time-off",
  "gateway-and-marketplace",
  "communication",
  "help-and-support",
  "localization",
  "legal",
];
const PERSONAL_PAGES = [
  "profile",
  "profile-privacy",
  "preferences",
  "accessibility",
  "out-of-office",
  "keyboard-shortcuts",
  "organizations",
];

test("settings pages render axe clean and the org lock holds", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const id = uniqueId();
  const slug = `settings-${id}`;
  await signUp(page, { name: "Sasha Settings", email: testEmail("settings", id) });
  await createOrganization(page, { name: `Settings ${id}`, slug });

  for (const section of ORG_PAGES) {
    const response = await page.goto(`/${slug}/settings/${section}`);
    expect(response?.status(), section).toBe(200);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expectAccessible(page);
  }
  for (const section of PERSONAL_PAGES) {
    const response = await page.goto(`/${slug}/me/${section}`);
    expect(response?.status(), section).toBe(200);
    await expectAccessible(page);
  }

  // Journey 63: lock the time zone at org level.
  await page.goto(`/${slug}/settings/localization`);
  const zone = page.locator("form").filter({ has: page.getByLabel("Time zone") });
  await zone.getByLabel("Time zone").selectOption("America/New_York");
  await zone.getByLabel(/Lock this value/).check();
  await zone.getByRole("button", { name: "Save" }).click();
  await expect(zone.getByText(/Set and locked for the organization/)).toBeVisible();

  // Personal preferences show the locked value as locked for the person.
  await page.goto(`/${slug}/me/preferences`);
  await expect(page.getByText(/set this value and locked it/)).toBeVisible();

  // Journey 51: turn Hospitality off; it leaves the sidebar.
  await page.goto(`/${slug}/settings/modules`);
  await page.getByRole("checkbox", { name: "Hospitality" }).uncheck();
  await page.getByRole("button", { name: "Save modules" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.goto(`/${slug}/home`);
  await expect(page.locator(`a[href="/${slug}/hospitality"]`)).toHaveCount(0);

  // A24-003: Site Operations is switchable too, and the whole form saves in one pass.
  await page.goto(`/${slug}/settings/modules`);
  await expect(page.getByRole("checkbox", { name: "Hospitality" })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Site Operations" }).uncheck();
  await page.getByRole("button", { name: "Save modules" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.goto(`/${slug}/home`);
  await expect(page.locator(`a[href="/${slug}/site-ops"]`)).toHaveCount(0);
  await expect(page.locator(`a[href="/${slug}/hospitality"]`)).toHaveCount(0);
  await page.goto(`/${slug}/settings/modules`);
  await page.getByRole("checkbox", { name: "Site Operations" }).check();
  await page.getByRole("button", { name: "Save modules" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.goto(`/${slug}/home`);
  await expect(page.locator(`a[href="/${slug}/site-ops"]`).first()).toBeAttached();
});
