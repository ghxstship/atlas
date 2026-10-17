import { expect as baseExpect, test } from "@playwright/test";
import { atlasAs, ORG } from "./atlas";
import { publishCrewOpportunity } from "./fixtures";
import { asPerson, PEOPLE } from "./role-fixtures";
import { DEMO, expectAccessible, signIn, sql, uniqueId } from "./support";

/**
 * Profiles across the surfaces (Section 20.2):
 *   61  the crew person sets their profile to Network with rates Private and shares their profile
 *       with one org through an application: a stranger gets 404, a past collaborator sees the
 *       Network fields without the rates, the applied-to org reads the shared fields and another
 *       org reads none. Atlas shows no shared-profile view yet (finding A38-003), so the org side is
 *       read through its row level security.
 *   62  the demo org publishes its Public profile in Atlas; Gateway shows it with its verified
 *       domain badge and open opportunities, carrying noindex until indexing is turned on.
 *       Case studies and an Explore listing of organizations do not exist yet (A38-003).
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

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

test.afterEach(resetCrewPrivacy);

test("journey 61: a Network profile with rates hidden, shared with one org", async ({
  page,
  browser,
}) => {
  await signIn(page, "crew@example.com", "/settings/profile-privacy");
  const form = page.getByRole("form", { name: "Profile privacy" });
  await form.getByLabel("Who sees your profile").selectOption("Network");
  await form.getByLabel("Rates").selectOption("Private");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByText(/^Saved/)).toBeVisible();
  await expectAccessible(page);

  // A stranger, signed out or signed in with no shared org, gets nothing.
  const anon = await browser.newContext();
  const stranger = await anon.newPage();
  expect((await stranger.goto("/u/demo-crew"))?.status()).toBe(404);
  await signIn(stranger, "client@example.com");
  expect((await stranger.goto("/u/demo-crew"))?.status()).toBe(404);
  await anon.close();

  // A past collaborator (the demo vendor, engaged by the same org) sees the Network fields only.
  const vendorContext = await browser.newContext();
  const vendor = await vendorContext.newPage();
  await signIn(vendor, "vendor@example.com");
  expect((await vendor.goto("/u/demo-crew"))?.status()).toBe(200);
  await expect(vendor.getByText("Rigger and stagehand, arena and festival")).toBeVisible();
  await expect(vendor.getByText(/\$450/)).toHaveCount(0);
  await expectAccessible(vendor);
  await vendorContext.close();

  // Applying shares the chosen profile fields with that one org.
  const opportunity = await publishCrewOpportunity(false);
  await page.goto(`/explore/${opportunity.key}`);
  const apply = page.getByRole("form", { name: /^Apply for / });
  await apply.getByLabel("Your name").check();
  await apply.getByLabel("Your email").check();
  await apply.getByLabel("I am available for these dates").check();
  await apply.getByRole("button", { name: "Send application" }).click();
  await expect(page.getByText(/You applied on/)).toBeVisible();

  const shared = (person: string) =>
    asPerson<{ field_key: string }>(
      person,
      `select f.field_key from app.profile_share_fields f
         join app.applications a on a.profile_share_id = f.profile_share_id
        where a.opportunity_id = $1 order by f.field_key`,
      [opportunity.id],
    );
  expect((await shared(PEOPLE.producer)).map((r) => r.field_key)).toEqual(["email", "full_name"]);
  // Another org's Owner reads none of it.
  expect(await shared("01920000-0000-7000-8000-000010800111")).toEqual([]);
});

test("journey 62: the org's Public profile with its badge and openings, noindex by default", async ({
  page,
  browser,
}) => {
  const about = `Festival and arena productions across South Florida ${uniqueId()}.`;
  const atlas = await atlasAs(browser, "owner@example.com");
  await atlas.page.goto(`/${ORG}/settings/organization-profile`);
  const profile = atlas.page.locator("form").filter({ has: atlas.page.getByLabel("About") });
  await profile.getByLabel("About").fill(about);
  await profile.getByLabel("Who sees your profile").selectOption("Public");
  await expect(profile.getByLabel("Let search engines index this profile")).not.toBeChecked();
  await profile.getByRole("button", { name: "Save profile" }).click();
  await expect
    .poll(async () => {
      const [r] = await sql<{ about: string | null }>(
        `select about from app.organization_profiles where org_id = $1`,
        [DEMO.org],
      );
      return r?.about;
    })
    .toBe(about);
  await expectAccessible(atlas.page);
  await atlas.context.close();

  const opportunity = await publishCrewOpportunity(false);
  // Signed out: the profile reads, with the verified badge, and carries noindex.
  expect((await page.goto("/c/demo-productions"))?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Demo Productions" })).toBeVisible();
  await expect(page.getByText(about)).toBeVisible();
  await expect(page.getByRole("article").getByText("Verified", { exact: true })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expectAccessible(page);

  // Signed in, the open opportunities show on it.
  await signIn(page, "crew@example.com");
  await page.goto("/c/demo-productions");
  await expect(page.getByRole("link", { name: opportunity.title })).toBeVisible();
  const [row] = await sql<{ search_indexing: boolean }>(
    `select search_indexing from app.organization_profiles where org_id = $1`,
    [DEMO.org],
  );
  expect(row?.search_indexing).toBe(false);
});
