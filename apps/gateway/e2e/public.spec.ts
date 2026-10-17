import { expect, test } from "./engine-test";
import { DEMO, expectAccessible, expectAccessibleInBothThemes, signIn, sql } from "./support";

/**
 * Public profiles and their privacy (Section 4.8.2 and 4.8.3; Section 20.2, journeys 61 and 62):
 * a Public profile is readable signed out and stays out of search engines unless the person opts
 * in; Private and Network profiles answer 404 to strangers; a section the person narrows to Private
 * disappears from the public page at once.
 */
async function resetCrewPrivacy(): Promise<void> {
  await sql(
    `update app.profile_section_visibility set deleted_at = now() where person_id = $1 and deleted_at is null`,
    [DEMO.crew],
    DEMO.crew,
  );
  await sql(
    `update app.person_profiles set visibility = 'Public', search_indexing = false where person_id = $1`,
    [DEMO.crew],
    DEMO.crew,
  );
}

test.beforeEach(resetCrewPrivacy);
test.afterAll(resetCrewPrivacy);

test("a public profile reads signed out and is not indexed by default", async ({ page }) => {
  const response = await page.goto("/u/demo-crew");
  expect(response?.status()).toBe(200);
  await expect(page.getByText("Rigger and stagehand, arena and festival")).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expectAccessibleInBothThemes(page);

  const company = await page.goto("/c/demo-productions");
  expect(company?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Demo Productions" })).toBeVisible();
  await expectAccessible(page);
});

test("private and network profiles answer 404 to strangers", async ({ page }) => {
  for (const handle of ["demo-admin", "demo-owner", "nobody-by-this-handle"]) {
    const response = await page.goto(`/u/${handle}`);
    expect(response?.status(), handle).toBe(404);
  }
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("narrowing a section to Private hides it from the public page", async ({ page, browser }) => {
  await signIn(page, "crew@example.com", "/settings/profile-privacy");
  const form = page.getByRole("form", { name: "Profile privacy" });
  await expect(form).toBeVisible();
  await expectAccessible(page);
  await form.getByLabel("Headline").selectOption("Private");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByText(/^Saved/)).toBeVisible();

  const stranger = await browser.newContext();
  const anonymous = await stranger.newPage();
  await anonymous.goto("/u/demo-crew");
  await expect(anonymous.getByText("Rigger and stagehand, arena and festival")).toHaveCount(0);
  await stranger.close();

  // The owner still sees the whole profile, with a note naming its visibility.
  await page.goto("/u/demo-crew");
  await expect(
    page.getByText("This is your profile as others see it. Visibility: Public."),
  ).toBeVisible();
});
