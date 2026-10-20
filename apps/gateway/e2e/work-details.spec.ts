import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import { DEMO, expectAccessible, signIn, sql, uniqueId } from "./support";

/**
 * Work Details across the surfaces (A78, finding A65-003, migration 1340):
 *   entering  the crew person adds an emergency contact (typed in national format, stored in E.164
 *             and shown back in national format), saves uniform sizes, and reveals their passport
 *             number, which every other view shows only by its last four; the access log says so.
 *   consent   on the crew engagement's Overview the person revokes the seeded share, and the demo
 *             Owner's engagement record in Atlas says nothing is shared; the person shares emergency
 *             contacts and dietary needs only, and Atlas shows exactly those; the person revokes
 *             again and Atlas shows nothing.
 * The seeded share (1340_a78.sql) is restored after each test.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const SEEDED = "{Emergency Contacts,Uniform Sizes,Dietary Needs,Passport}";

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

  const uniform = page.getByRole("form", { name: "Uniform sizes" });
  await uniform.getByLabel("Shirt").selectOption("XL");
  await uniform.getByRole("button", { name: "Save sizes" }).click();
  await expect(uniform.getByRole("status")).toHaveText("Saved.");

  await expect(page.getByText("Number on file ending 0000")).toBeVisible();
  const reveal = page.getByRole("form", { name: "Reveal number" });
  await reveal.getByRole("button", { name: "Reveal number" }).click();
  await expect(reveal.getByRole("status")).toHaveText("Passport number: TEST000000");
  await expectAccessible(page);

  await page.reload();
  const log = page.getByRole("region", { name: "Access log" });
  await expect(log.getByText(/Passport number revealed/).first()).toBeVisible();
  await expect(log).not.toContainText("TEST000000");
  await sql(`update app.person_work_details set shirt_size = 'L' where person_id = $1`, [
    DEMO.crew,
  ]);
});

test("Work Details: per-engagement consent decides what the engaging org sees", async ({
  page,
  browser,
}) => {
  await signIn(page, "crew@example.com", `/work/engagements/${DEMO.crewEngagementKey}/overview`);
  const sharing = page.getByRole("region", { name: "Sharing with engagements" });
  await sharing.getByRole("button", { name: "Revoke" }).click();
  await expect(sharing.getByText("Not shared")).toBeVisible();

  const atlas = await atlasAs(browser, "owner@example.com");
  const record = `/${ORG}/opportunities/engagements?id=${DEMO.crewEngagement}`;
  await atlas.page.goto(record);
  const shared = atlas.page.getByRole("region", { name: "Shared work details" });
  await expect(shared).toContainText("has not shared any work details");

  const choose = sharing.getByRole("form", { name: /Categories to share with Demo Productions/ });
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

  await page.reload();
  await sharing.getByRole("button", { name: "Revoke" }).click();
  await expect(sharing.getByText("Not shared")).toBeVisible();
  await atlas.page.reload();
  await expect(shared).toContainText("has not shared any work details");
  await atlas.context.close();
});
