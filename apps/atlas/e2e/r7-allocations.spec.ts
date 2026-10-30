import { expect as baseExpect, test } from "@playwright/test";
import pg from "pg";
import { DEMO_ORG, signInAs } from "./a36-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * R7 (RRR-187, ADR 0103 and 0104): allocations in Atlas, as the demo Owner, on a staffing agency engagement of
 * seed 1080 (Account Owner agency@example.com, accepted member Demo Staff One):
 *   - the Owner assigns one radio to the person from the Assign dialog, and the row shows Reserved;
 *   - the radio is issued by asset tag from the row's Issue dialog: the custody row names the roster entry and the
 *     reservation, and the row shows Issued;
 *   - the radio hand-out downloads as a PDF for the project;
 *   - canceling the engagement withdraws the allocation (the cascade), and the default list hides it.
 * The demo org provides radios and holds the unit through SQL as postgres on the local stack only, under the
 * Owner's claims where an RPC needs a person. Each run makes its own engagement and unit, and removes the
 * engagement afterwards.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 30_000 });

const DEMO_ORG_ID = "01920000-0000-7000-8000-000000000001";
const DEMO_OWNER = "01920000-0000-7000-8000-000000000101";
const DEMO_PROJECT_ID = "01920000-0000-7000-8000-000000001001";
const DEMO_PROJECT_KEY = "NWS";
const AGENCY = {
  owner: "01920000-0000-7000-8000-000010800101",
  staffOne: "01920000-0000-7000-8000-000010800102",
  account: "01920000-0000-7000-8000-000010800301",
} as const;

/** One statement as postgres against the local stack only, under `person`'s claims when given. */
async function localSql<T extends Record<string, unknown>>(
  text: string,
  args: unknown[] = [],
  person?: string,
): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error("The allocations journey changes data only on a local Supabase stack.");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    if (person) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: person, role: "authenticated" }),
      ]);
    }
    const result = await client.query(text, args);
    await client.query("commit");
    return result.rows as T[];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

/** The demo org provides radios; returns its Radios class and its name. */
async function radioClass(): Promise<{ id: string; name: string }> {
  await localSql(
    "select app.set_setting($1, 'offerings.radios', 'Organization', null, 'provided')",
    [DEMO_ORG_ID],
    DEMO_OWNER,
  );
  const [row] = await localSql<{ id: string; name: string }>(
    `select c.id, c.name from app.asset_classes c
      where c.id = app.ensure_offering_asset_class($1, 'Radios')`,
    [DEMO_ORG_ID],
    DEMO_OWNER,
  );
  if (!row) throw new Error("The demo org has no Radios class.");
  return row;
}

/** One Available radio with a fresh tag at the project's first venue. */
async function availableRadio(classId: string, tag: string): Promise<void> {
  await localSql(
    `with u as (
       insert into app.asset_units (asset_class_id, asset_tag, home_venue_id)
       values ($1, $2, (select v.id from app.venues v where v.org_id = $3 and v.deleted_at is null order by v.created_at limit 1))
       returning id)
     select private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions',
              'asset_unit_id', u.id, 'Proposed', 'Received', 'R7 journey.'),
            private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions',
              'asset_unit_id', u.id, 'Received', 'Available', 'R7 journey.')
       from u`,
    [classId, tag, DEMO_ORG_ID],
  );
}

/** An Active staffing engagement of the agency with Demo Staff One accepted on its roster. */
async function crewedEngagement(): Promise<{ engagement: string; entry: string }> {
  const [row] = await localSql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
       pay_basis, arrangement, agreed_rate_minor, currency_code, start_date, end_date)
     values ($1, $2,
       (select c.id from app.counterparties c where c.org_id = $3 and c.organization_id = $4 and c.deleted_at is null limit 1),
       'Staff', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 30000, 'USD', '2027-06-04', '2027-06-06')
     returning id`,
    [DEMO_PROJECT_ID, AGENCY.owner, DEMO_ORG_ID, AGENCY.account],
    DEMO_OWNER,
  );
  const engagement = row?.id as string;
  const [entry] = await localSql<{ id: string }>(
    "select app.add_roster_entry($1, $2) as id",
    [engagement, AGENCY.staffOne],
    AGENCY.owner,
  );
  await localSql("select app.submit_roster($1)", [engagement], AGENCY.owner);
  await localSql("select app.review_roster_entry($1, 'Accepted')", [entry?.id], DEMO_OWNER);
  await localSql("select app.respond_roster_entry($1, 'Accepted')", [entry?.id], AGENCY.staffOne);
  await localSql(
    "select app.transition_engagement($1, 'Onboarding', 'Active', 'R7 journey.')",
    [engagement],
    DEMO_OWNER,
  );
  return { engagement, entry: entry?.id as string };
}

test("allocations: assign a radio, issue it by tag, print the hand-out, and withdraw it on cancel", async ({
  page,
}) => {
  const id = uniqueId();
  const tag = `R7-${id}`.toUpperCase();
  const [names] = await localSql<{ one: string; party: string }>(
    `select (select full_name from app.people where id = $1) as one,
            (select name from app.organizations where id = $2) as party`,
    [AGENCY.staffOne, AGENCY.account],
  );
  const one = names?.one ?? "";
  const party = names?.party ?? "";
  const radios = await radioClass();
  await availableRadio(radios.id, tag);
  const { engagement, entry } = await crewedEngagement();
  const page_ = `/${DEMO_ORG}/advancing/allocations?project=${DEMO_PROJECT_KEY}`;
  try {
    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(page_);
    await expect(page.getByRole("heading", { level: 1, name: "Allocations" })).toBeVisible();
    await expectAccessible(page);

    // Assign one radio to the person; the Owner may assign, so it is Approved and held at once.
    await page.getByRole("button", { name: "Assign", exact: true }).click();
    const assign = page.getByRole("dialog", { name: "Assign an allocation" });
    await assign.getByLabel("Held by").selectOption({ label: `${one} · ${party}` });
    await assign.getByLabel("Kind").selectOption({ label: "Equipment" });
    await assign.getByLabel("Item").selectOption({ label: radios.name });
    await assign.getByLabel("Quantity").fill("1");
    await assign.getByLabel("Needed from").fill("2027-06-04T08:00");
    await assign.getByLabel("Needed until").fill("2027-06-06T20:00");
    await expectAccessible(page);
    await assign.getByRole("button", { name: "Assign", exact: true }).click();
    await expect(assign).toBeHidden();
    const row = page
      .getByRole("listitem")
      .filter({ hasText: one })
      .filter({ hasText: radios.name });
    await expect(row).toContainText("Reserved");
    const [allocation] = await localSql<{ id: string; state: string }>(
      `select id, allocation_state::text as state from app.advance_allocations
        where roster_entry_id = $1 and deleted_at is null`,
      [entry],
    );
    expect(allocation?.state).toBe("Approved");

    // Issue by tag: the custody row names the entry and the reservation, and the row shows Issued.
    await row.getByRole("button", { name: "Issue" }).click();
    const issue = page.getByRole("dialog", { name: `Issue ${radios.name}` });
    await issue.getByLabel("Asset tags").fill(tag);
    await issue.getByRole("button", { name: "Issue", exact: true }).click();
    await expect(issue).toBeHidden();
    await expect(row).toContainText("Issued");
    const [custody] = await localSql<{ entry: string | null; reservation: string | null }>(
      `select c.roster_entry_id as entry, c.reservation_id as reservation
         from app.asset_custody c join app.asset_units u on u.id = c.asset_unit_id
        where u.asset_tag = $1 and c.deleted_at is null
        order by c.created_at desc limit 1`,
      [tag],
    );
    expect(custody?.entry).toBe(entry);
    expect(custody?.reservation).not.toBeNull();

    // The radio hand-out for the project downloads as a PDF.
    const handout = await page.request.get(
      `/${DEMO_ORG}/documents/radio-handout/${DEMO_PROJECT_ID}`,
    );
    expect(handout.status()).toBe(200);
    expect(handout.headers()["content-type"]).toBe("application/pdf");
    expect(handout.headers()["content-disposition"]).toContain("radio-handout-NWS-RADIOS");

    // Canceling the engagement withdraws the allocation; the default list hides it, the Withdrawn filter shows it.
    await localSql(
      "select app.transition_engagement($1, 'Active', 'Canceled', 'R7 journey cancel.')",
      [engagement],
      DEMO_OWNER,
    );
    const [after] = await localSql<{ state: string; cause: string | null }>(
      "select allocation_state::text as state, withdraw_cause::text as cause from app.advance_allocations where id = $1",
      [allocation?.id],
    );
    expect(after?.state).toBe("Withdrawn");
    await page.goto(page_);
    await expect(
      page.getByRole("listitem").filter({ hasText: one }).filter({ hasText: radios.name }),
    ).toHaveCount(0);
    await page.goto(`${page_}&filter=Withdrawn`);
    await expect(
      page.getByRole("listitem").filter({ hasText: one }).filter({ hasText: radios.name }),
    ).toContainText("Withdrawn");
  } finally {
    await localSql(
      `update app.engagements set deleted_at = now() where id = $1 and deleted_at is null`,
      [engagement],
    );
  }
});
