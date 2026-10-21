import { expect, test } from "./engine-test";
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
  // A59-018: the page has one form and no Save button until something changes; the save bar
  // counts the changes, Discard puts them back, and Save sends them together.
  await page.goto(`/${slug}/settings/localization`);
  const form = page.getByRole("form", { name: "Settings on this page" });
  const zone = form.locator("li").filter({ has: page.getByLabel("Time zone") });
  await expect(form.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await zone.getByLabel("Time zone").selectOption("Europe/London");
  await expect(form.getByText("1 unsaved change")).toBeVisible();
  await form.getByRole("button", { name: "Discard" }).click();
  await expect(form.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await zone.getByLabel("Time zone").selectOption("America/New_York");
  await zone.getByRole("button", { name: "Lock value" }).click();
  await expect(zone.getByRole("button", { name: "Lock value" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expectAccessible(page);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(zone.getByText(/Set and locked for the organization/)).toBeVisible();
  await expect(form.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

  // Personal preferences show the locked value as locked for the person.
  await page.goto(`/${slug}/me/preferences`);
  await expect(page.getByText(/set this value and locked it/)).toBeVisible();

  // Journey 51: turn Hospitality off; it leaves the sidebar.
  await page.goto(`/${slug}/settings/modules`);
  await page.getByRole("button", { name: "More fields" }).click();
  await page.getByRole("checkbox", { name: "Hospitality" }).uncheck();
  await page.getByRole("button", { name: "Save modules" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.goto(`/${slug}/home`);
  await expect(page.locator(`a[href="/${slug}/hospitality"]`)).toHaveCount(0);

  // A24-003: Site Operations is switchable too, and the whole form saves in one pass.
  await page.goto(`/${slug}/settings/modules`);
  await page.getByRole("button", { name: "More fields" }).click();
  await expect(page.getByRole("checkbox", { name: "Hospitality" })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Site Operations" }).uncheck();
  await page.getByRole("button", { name: "Save modules" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.goto(`/${slug}/home`);
  await expect(page.locator(`a[href="/${slug}/site-ops"]`)).toHaveCount(0);
  await expect(page.locator(`a[href="/${slug}/hospitality"]`)).toHaveCount(0);
  await page.goto(`/${slug}/settings/modules`);
  await page.getByRole("button", { name: "More fields" }).click();
  await page.getByRole("checkbox", { name: "Site Operations" }).check();
  await page.getByRole("button", { name: "Save modules" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.goto(`/${slug}/home`);
  await expect(page.locator(`a[href="/${slug}/site-ops"]`).first()).toBeAttached();
});

// ADR 0038: record keys are fixed and on no settings screen; gateway.ratings_enabled only prompts members to
// rate, so turning it off removes the prompt and nothing else.
test("record keys stay fixed and rating prompts never hide ratings", async ({ page }) => {
  const id = uniqueId();
  const slug = `ratings-${id}`;
  await signUp(page, { name: "Riley Ratings", email: testEmail("ratings", id) });
  await createOrganization(page, { name: `Ratings ${id}`, slug });

  await page.goto(`/${slug}/settings/numbering`);
  await expect(page.getByLabel("Number padding")).toBeVisible();
  await expect(page.getByLabel("Record key format")).toHaveCount(0);
  await expect(page.getByText(/record keys like NWS-42 are fixed/)).toBeVisible();

  await page.goto(`/${slug}/opportunities/ratings`);
  await expect(page.getByText("Waiting for your rating")).toBeVisible();

  await page.goto(`/${slug}/settings/gateway-and-marketplace`);
  const form = page.getByRole("form", { name: "Settings on this page" });
  const prompts = form.getByLabel("Prompt members to rate parties");
  await expect(prompts).toBeChecked();
  await expect(form.getByText(/turning prompts off never hides or removes a rating/)).toBeVisible();
  await prompts.uncheck();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(prompts).not.toBeChecked();
  await expectAccessible(page);

  // The prompt goes; the ratings page and every rating on it stay.
  await page.goto(`/${slug}/opportunities/ratings`);
  await expect(page.getByRole("heading", { level: 1, name: "Ratings" })).toBeVisible();
  await expect(page.getByText("Waiting for your rating")).toHaveCount(0);
});
