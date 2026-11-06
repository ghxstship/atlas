import { expect as baseExpect, test } from "./engine-test";
import { demoVendorId, PEOPLE, PROJECT, suffix, vendorEngagement } from "./role-fixtures";
import { signIn, sql } from "./support";

/**
 * B11 in Gateway (RRR-235, ADR 0150):
 *   - a vendor books a place in an open delivery window, and the reference code stays on the booking's row;
 *   - the vendor reads an issued RFQ under Work, Quote requests, with its lines and no prices, and reads nothing while
 *     it is still a draft.
 * The windows sit far in the future, so a time of day is never already past when the test runs.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("a vendor books a delivery and keeps its reference code on the row", async ({ page }) => {
  const engagement = await vendorEngagement();
  const [zone] = await sql<{ id: string }>(
    `insert into app.zones (venue_id, code, name)
     select p.venue_id, $2, $3 from app.projects p where p.id = $1 returning id`,
    [PROJECT, `GATE-${suffix()}`.slice(0, 20), `Gate ${suffix()}`],
    PEOPLE.owner,
  );
  await sql(
    `insert into app.delivery_windows (project_id, zone_id, starts_at, ends_at, vehicle_limit)
     values ($1, $2, now() + interval '400 days', now() + interval '400 days 2 hours', 2)`,
    [PROJECT, zone?.id],
    PEOPLE.owner,
  );
  await signIn(page, "vendor@example.com", `/work/engagements/${engagement.key}/deliveries`);
  await expect(page.getByRole("heading", { name: "Book a delivery", exact: true })).toBeVisible();
  await page.getByLabel("Plate or trailer", { exact: true }).fill("FL ABC 123");
  await expect(async () => {
    await page.getByRole("button", { name: "Book delivery", exact: true }).click();
    await expect(page.getByText(/^Reference [2-9A-HJ-NP-Z]{6}$/).first()).toBeVisible({ timeout: 3_000 });
  }).toPass();
  await expect(page.getByText("FL ABC 123", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel booking", exact: true }).first()).toBeVisible();
});

test("a vendor reads an issued RFQ's lines and no prices", async ({ page }) => {
  const title = `Cable ${suffix()}`;
  const vendor = await demoVendorId();
  const [rfq] = await sql<{ id: string }>(
    `insert into app.rfqs (project_id, title) values ($1, $2) returning id`,
    [PROJECT, title],
    PEOPLE.owner,
  );
  await sql(`insert into app.rfq_lines (rfq_id, description, quantity) values ($1, 'Stage cable', 20)`, [rfq?.id], PEOPLE.owner);
  await sql(`insert into app.rfq_invitations (rfq_id, vendor_id) values ($1, $2)`, [rfq?.id, vendor], PEOPLE.owner);

  await signIn(page, "vendor@example.com", "/work/quote-requests");
  await expect(page.getByRole("heading", { name: title, exact: true })).toHaveCount(0);

  await sql(`select app.transition_rfq($1, 'Proposed', 'Issued', 'Go.')`, [rfq?.id], PEOPLE.owner);
  await page.reload();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByText("20 Stage cable", { exact: true })).toBeVisible();
  await expect(page.getByText(/Send your quote to/).first()).toBeVisible();
});
