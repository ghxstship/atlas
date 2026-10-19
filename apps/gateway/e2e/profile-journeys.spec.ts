import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import { publishCrewOpportunity } from "./fixtures";
import { asPerson, newSignIn, PEOPLE } from "./role-fixtures";
import { DEMO, expectAccessible, signIn, sql, uniqueId } from "./support";

/**
 * Profiles across the surfaces (Section 20.2):
 *   61  the crew person sets their profile to Network with rates Private and shares their profile
 *       with one org through an application, section by section, rates included: a stranger gets
 *       404, a past collaborator sees the Network fields without the rates, the applied-to org
 *       reads the shared fields (on the application in Atlas, Shared with you) and another org
 *       reads none (finding A38-003, migration 1132).
 *   62  the demo org publishes its Public profile in Atlas; Gateway shows it with its verified
 *       badge, its verified domain, case studies and open opportunities, carrying noindex until
 *       indexing is turned on, and it appears in Explore, Organizations.
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
  // Sections past the seventh field sit under More fields (gate 27).
  await form.getByRole("button", { name: "More fields" }).click();
  await form.getByLabel("Rates").selectOption("Private");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByText(/^Saved/)).toBeVisible();
  await expectAccessible(page);

  // A stranger, signed out or signed in with no shared org, gets nothing.
  const anon = await browser.newContext();
  const stranger = await anon.newPage();
  expect((await stranger.goto("/u/demo-crew"))?.status()).toBe(404);
  // A person new to the platform: seeded people may share an org with the crew person once other
  // journeys have engaged them.
  const strangerEmail = `stranger-${uniqueId()}@example.com`;
  await newSignIn(strangerEmail, "Demo Stranger");
  await signIn(stranger, strangerEmail);
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
  // The full profile, section by section, including the rates kept Private elsewhere.
  for (const section of ["Headline", "Location", "Skills", "Rates"]) {
    await apply.getByLabel(section, { exact: true }).check();
  }
  await apply.getByLabel("I am available for these dates").check();
  await apply.getByRole("button", { name: "Send application" }).click();
  await expect(page.getByText(/You applied on|Application sent/).first()).toBeVisible();

  const shared = (person: string) =>
    asPerson<{ field_key: string }>(
      person,
      `select f.field_key from app.profile_share_fields f
         join app.applications a on a.profile_share_id = f.profile_share_id
        where a.opportunity_id = $1 order by f.field_key`,
      [opportunity.id],
    );
  expect((await shared(PEOPLE.producer)).map((r) => r.field_key)).toEqual([
    "email",
    "full_name",
    "profile.headline",
    "profile.location",
    "profile.rates",
    "profile.skills",
  ]);
  // Another org's Owner reads none of it.
  expect(await shared("01920000-0000-7000-8000-000010800111")).toEqual([]);

  // The org applied to sees what was shared on the application in Atlas, rate included.
  const [application] = await sql<{ id: string }>(
    `select id from app.applications where opportunity_id = $1 and applicant_person_id = $2`,
    [opportunity.id, DEMO.crew],
  );
  const atlas = await atlasAs(browser, "producer@example.com");
  await atlas.page.goto(`/${ORG}/opportunities/pipeline?id=${application?.id as string}`);
  const panel = atlas.page.getByRole("region", { name: "Shared with you" });
  await expect(panel.getByText("Rigger and stagehand, arena and festival")).toBeVisible();
  await expect(panel.getByText(/\$450\.00 per day/)).toBeVisible();
  await expect(panel.getByText("crew@example.com")).toBeVisible();
  await expectAccessible(atlas.page);
  await atlas.context.close();
});

test("journey 62: the org's Public profile with its badge and openings, noindex by default", async ({
  page,
  browser,
}) => {
  const about = `Festival and arena productions across South Florida ${uniqueId()}.`;
  const atlas = await atlasAs(browser, "owner@example.com");
  await atlas.page.goto(`/${ORG}/settings/organization-profile`);
  // Typing into the textarea before hydration finishes merges the typed text with the default.
  await atlas.page.waitForLoadState("networkidle");
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
  // The verified domain comes from the org's verified domain row (seed 1130), and the published
  // case studies show (finding A38-003).
  await expect(page.getByText("demo-productions.example.com")).toBeVisible();
  const caseStudies = page.getByRole("region", { name: "Case studies" });
  await expect(caseStudies.getByRole("heading", { name: "Bayfront Summer Series" })).toBeVisible();
  await expect(
    caseStudies.getByRole("heading", { name: "Arena residency changeovers" }),
  ).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expectAccessible(page);

  // Signed in, the org's open opportunities show on it (the twelve closing soonest; earlier runs
  // leave more than twelve open on a reused stack, so the check is on the section's listings).
  await signIn(page, "crew@example.com");
  await page.goto("/c/demo-productions");
  const openings = page.getByRole("region", { name: "Open opportunities" });
  await expect(
    openings.getByRole("link", { name: /Festival Truss Riggers/ }).first(),
  ).toBeVisible();
  const [listed] = await sql<{ n: string }>(
    `select count(*)::text as n from app.opportunities where id = $1 and opportunity_state = 'Published'`,
    [opportunity.id],
  );
  expect(listed?.n).toBe("1");
  const [row] = await sql<{ search_indexing: boolean }>(
    `select search_indexing from app.organization_profiles where org_id = $1`,
    [DEMO.org],
  );
  expect(row?.search_indexing).toBe(false);

  // It appears in Explore, Organizations, with its badge, domain and open opportunities.
  await page.goto("/explore?show=organizations&q=Demo%20Productions");
  const orgCards = page.getByRole("list", { name: "Organizations" }).getByRole("listitem");
  const card = orgCards.filter({
    has: page.getByRole("link", { name: "Demo Productions", exact: true }),
  });
  await expect(card.getByText("Verified", { exact: true })).toBeVisible();
  await expect(card.getByText("demo-productions.example.com")).toBeVisible();
  // The count is of Public openings; the fixture opening is Invited, so it may be none.
  await expect(card.getByText(/open opportunit/i)).toBeVisible();
  await expectAccessible(page);
  await card.getByRole("link", { name: "Demo Productions", exact: true }).click();
  await expect(page).toHaveURL(/\/c\/demo-productions$/);
});
