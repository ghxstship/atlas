import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import { DEMO, expectAccessible, signIn, sql, uniqueId } from "./support";

/**
 * Work Details across the surfaces (A78, finding A65-003, migration 1340):
 *   entering  the crew person adds an emergency contact (typed in national format, stored in E.164
 *             and shown back in national format) and reveals their passport number, which every
 *             other view shows only by its last four; the access log says so. Since R6a there is no
 *             Uniform section, a notice says sizes and travel preferences are asked per project, the
 *             travel profile is loyalty programs only, and Uniform Sizes cannot be shared.
 *   consent   on the crew engagement's Overview the person revokes the seeded share, and the demo
 *             Owner's engagement record in Atlas says nothing is shared; the person shares emergency
 *             contacts and dietary needs only, and Atlas shows exactly those, the Restricted
 *             allergies included for the Owner, which the person's access log records; the person
 *             revokes again and Atlas shows nothing.
 * The seeded share (1340_a78.sql) is restored after each test.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

// Uniform Sizes is retired (R6a, 2664), so the seed no longer shares it.
const SEEDED = "{Emergency Contacts,Dietary Needs,Passport}";

test.afterEach(async () => {
  await sql(
    `update app.person_emergency_contacts set deleted_at = now()
     where person_id = $1 and full_name like 'Journey Contact %' and deleted_at is null`,
    [DEMO.crew],
    DEMO.crew,
  );
  await sql(
    `select app.share_work_details($1, $2::app.work_detail_category[])`,
    [DEMO.crewEngagement, SEEDED],
    DEMO.crew,
  );
});

test("Work Details: the crew person enters their details and reveals the passport number", async ({
  page,
}) => {
  await signIn(page, "crew@example.com", "/settings/work-details");
  await expect(page.getByRole("heading", { name: "Emergency contacts" })).toBeVisible();
  // R6a: uniform sizes and travel preferences are asked per project.
  await expect(
    page.getByText("Uniform sizes and travel preferences moved to each project"),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open your engagements" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Uniform sizes" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Loyalty programs" })).toBeVisible();
  await expect(page.getByLabel("Home airport")).toHaveCount(0);
  await expect(page.getByLabel("Seat", { exact: true })).toHaveCount(0);

  const name = `Journey Contact ${uniqueId()}`;
  const add = page.getByRole("form", { name: "Add contact" });
  await add.getByLabel("Name").fill(name);
  await add.getByLabel("Relationship").fill("Friend");
  await add.getByLabel("Phone", { exact: true }).fill("305 555 0177");
  await add.getByRole("button", { name: "Add contact" }).click();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText("(305) 555-0177");
  const stored = await sql<{ phone: string }>(
    `select phone_e164 as phone from app.person_emergency_contacts where person_id = $1 and full_name = $2`,
    [DEMO.crew, name],
  );
  expect(stored[0]?.phone).toBe("+13055550177");

  await expect(page.getByText("Number on file ending 0000")).toBeVisible();
  const reveal = page.getByRole("form", { name: "Reveal number" });
  await reveal.getByRole("button", { name: "Reveal number" }).click();
  await expect(reveal.getByRole("status")).toHaveText("Passport number: TEST000000");
  await expectAccessible(page);

  await page.reload();
  const log = page.getByRole("region", { name: "Access log" });
  await expect(log.getByText(/Passport number revealed/).first()).toBeVisible();
  await expect(log).not.toContainText("TEST000000");
});

test("Work Details: per-engagement consent decides what the engaging org sees", async ({
  page,
  browser,
}) => {
  const overview = `/work/engagements/${DEMO.crewEngagementKey}/overview`;
  await signIn(page, "crew@example.com", overview);
  const sharing = page.getByRole("region", { name: "Sharing with engagements" });
  await sharing.getByRole("button", { name: "Revoke" }).click();
  await expect(sharing.getByText("Not shared")).toBeVisible();

  const atlas = await atlasAs(browser, "owner@example.com");
  const record = `/${ORG}/opportunities/engagements?id=${DEMO.crewEngagement}`;
  await atlas.page.goto(record);
  const shared = atlas.page.getByRole("region", { name: "Shared work details" });
  await expect(shared).toContainText("has not shared any work details");

  const choose = sharing.getByRole("form", { name: /Categories to share with Demo Productions/ });
  // Uniform Sizes is retired (R6a): it is not offered.
  await expect(choose.getByLabel("Uniform sizes")).toHaveCount(0);
  await choose.getByLabel("Emergency contacts").check();
  await choose.getByLabel("Dietary needs").check();
  await choose.getByRole("button", { name: "Share selected" }).click();
  await expect(sharing.getByText(/^Shared /)).toBeVisible();
  await expectAccessible(page);

  await atlas.page.reload();
  await expect(shared.getByRole("heading", { name: "Emergency contacts" })).toBeVisible();
  await expect(shared).toContainText("Demo Emergency Contact");
  await expect(shared).toContainText("(305) 555-0123");
  await expect(shared).toContainText("Shellfish, mild");
  await expect(shared.getByRole("heading", { name: "Uniform sizes" })).toHaveCount(0);
  await expect(shared.getByRole("heading", { name: "Passport" })).toHaveCount(0);
  await expectAccessible(atlas.page);
  const viewed = await sql<{ n: number }>(
    `select count(*)::int as n from app.work_detail_events
     where person_id = $1 and action = 'work_details.viewed' and org_id = $2`,
    [DEMO.crew, DEMO.org],
  );
  expect(viewed[0]?.n ?? 0).toBeGreaterThan(0);

  // The Owner holds data.restricted.read.medical, so each read of the allergies is logged (R6a).
  await page.goto("/settings/work-details");
  await expect(
    page
      .getByRole("region", { name: "Access log" })
      .getByText(/Allergies viewed by Demo Productions/)
      .first(),
  ).toBeVisible();

  await page.goto(overview);
  await sharing.getByRole("button", { name: "Revoke" }).click();
  await expect(sharing.getByText("Not shared")).toBeVisible();
  await atlas.page.reload();
  await expect(shared).toContainText("has not shared any work details");
  await atlas.context.close();
});
