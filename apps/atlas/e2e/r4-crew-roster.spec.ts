import { expect as baseExpect, test, type Page } from "@playwright/test";
import pg from "pg";
import { DEMO_ORG, signInAs } from "./a36-support";

/**
 * R4 (RRR-182, ADR 0101): the crew roster in Atlas, as the demo Owner, on staffing agency
 * engagements of seed 1080 (Account Owner agency@example.com, accepted members Demo Staff One and
 * Two):
 *   - a submitted entry is returned with a reason from its row's dialog;
 *   - two submitted entries are accepted in one bulk change after a preview;
 *   - the profile peek reads the shared work details of a person who accepted their entry, with
 *     their allergies, which the Owner reads as a holder of data.restricted.read.medical (R6a).
 * The agency builds and submits its rosters through the same RPCs Gateway calls, as postgres on the
 * local stack under the agency owner's claims. Each run makes its own engagements and removes them,
 * with their entries and share, afterwards.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const DEMO_ORG_ID = "01920000-0000-7000-8000-000000000001";
const DEMO_OWNER = "01920000-0000-7000-8000-000000000101";
const DEMO_PROJECT_ID = "01920000-0000-7000-8000-000000001001";
const DEMO_PROJECT_KEY = "NWS";
const AGENCY = {
  owner: "01920000-0000-7000-8000-000010800101",
  staffOne: "01920000-0000-7000-8000-000010800102",
  staffTwo: "01920000-0000-7000-8000-000010800103",
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
    throw new Error("The crew roster journey builds its rosters only on a local Supabase stack.");
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

/** A staffing engagement of the agency on the demo project, in Onboarding, with its account as counterparty. */
async function agencyEngagement(): Promise<string> {
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
  return row?.id as string;
}

/** The agency owner puts people on an engagement's roster and submits it; returns the entry ids. */
async function submittedRoster(engagementId: string, people: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const person of people) {
    const [row] = await localSql<{ id: string }>(
      "select app.add_roster_entry($1, $2) as id",
      [engagementId, person],
      AGENCY.owner,
    );
    ids.push(row?.id as string);
  }
  await localSql("select app.submit_roster($1)", [engagementId], AGENCY.owner);
  return ids;
}

/** The roster list item of one entry, by the person's name inside the party's section. */
function rosterItem(page: Page, party: string, name: string) {
  return page.getByRole("region", { name: party }).getByRole("listitem").filter({ hasText: name });
}

test("crew roster: return with a reason, bulk accept, and the profile peek", async ({ page }) => {
  const [names] = await localSql<{ one: string; two: string; party: string }>(
    `select (select full_name from app.people where id = $1) as one,
            (select full_name from app.people where id = $2) as two,
            (select name from app.organizations where id = $3) as party`,
    [AGENCY.staffOne, AGENCY.staffTwo, AGENCY.account],
  );
  const one = names?.one ?? "";
  const two = names?.two ?? "";
  const party = names?.party ?? "";
  const allergy = `Peanuts, anaphylaxis ${Date.now().toString(36)}`;
  const [details] = await localSql<{ id: string | null; allergies: string | null }>(
    `select id, allergies from app.person_work_details where person_id = $1 and deleted_at is null`,
    [AGENCY.staffOne],
  );
  const engagements: string[] = [];
  const crew = `/${DEMO_ORG}/p/${DEMO_PROJECT_KEY}/advancing?section=crew`;
  try {
    // One submitted entry, returned with a reason from its row's dialog.
    const returned = await agencyEngagement();
    engagements.push(returned);
    await submittedRoster(returned, [AGENCY.staffOne]);

    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(crew);
    const item = rosterItem(page, party, one);
    await expect(item).toContainText("Submitted");
    await item.getByRole("button", { name: "Return" }).click();
    const dialog = page.getByRole("dialog", { name: `Return ${one}` });
    await dialog.getByLabel("What should change").fill("Add the arrival window for load-in.");
    await dialog.getByRole("button", { name: "Return entry" }).click();
    await expect(dialog).toBeHidden();
    await expect(item).toContainText("Returned");
    const [ledger] = await localSql<{ reason: string }>(
      `select t.reason from app.roster_entry_state_transitions t
         join app.engagement_roster_entries e on e.id = t.roster_entry_id
        where e.engagement_id = $1 and t.to_state = 'Returned'`,
      [returned],
    );
    expect(ledger?.reason).toBe("Add the arrival window for load-in.");

    // Two submitted entries accepted in one bulk change, after a preview.
    const accepted = await agencyEngagement();
    engagements.push(accepted);
    const [entryOne] = await submittedRoster(accepted, [AGENCY.staffOne, AGENCY.staffTwo]);
    await page.goto(`${crew}&view=table&filter=Submitted`);
    const grid = page.getByRole("grid");
    const rowOne = grid.getByRole("row").filter({ hasText: one });
    const rowTwo = grid.getByRole("row").filter({ hasText: two });
    await expect(rowOne).toHaveCount(1);
    await expect(rowTwo).toHaveCount(1);
    await rowOne.getByRole("checkbox").click();
    await rowTwo.getByRole("checkbox").click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByRole("status").filter({ hasText: "2 selected" })).toBeAttached();
    await page
      .getByRole("toolbar", { name: "Bulk actions" })
      .getByRole("button", { name: "Change Entry state" })
      .click();
    const bulk = page.getByRole("dialog", { name: /Change Entry state on 2 rows/ });
    await bulk.getByLabel("New Entry state").selectOption({ label: "Accept" });
    await bulk.getByRole("button", { name: "Preview" }).click();
    await expect(bulk.getByText("2 rows will change.")).toBeVisible();
    await bulk.getByRole("button", { name: "Apply to 2 rows" }).click();
    await expect(page.getByText("Changed 2 rows.").first()).toBeVisible();
    const states = await localSql<{ state: string }>(
      `select entry_state::text as state from app.engagement_roster_entries
        where engagement_id = $1 and not is_self and deleted_at is null`,
      [accepted],
    );
    expect(states.map((s) => s.state)).toEqual(["Accepted", "Accepted"]);

    // The person accepts the entry and shares dietary needs; the peek reads them, logged.
    if (details?.id) {
      await localSql("update app.person_work_details set allergies = $2 where id = $1", [
        details.id,
        allergy,
      ]);
    } else {
      await localSql("insert into app.person_work_details (person_id, allergies) values ($1, $2)", [
        AGENCY.staffOne,
        allergy,
      ]);
    }
    await localSql("select app.respond_roster_entry($1, 'Accepted')", [entryOne], AGENCY.staffOne);
    await localSql(
      "select app.share_work_details($1, '{Dietary Needs}'::app.work_detail_category[])",
      [accepted],
      AGENCY.staffOne,
    );
    await page.goto(`${crew}&peek=${entryOne}`);
    const peek = page.getByRole("region", { name: "Shared profile" });
    await expect(peek).toContainText("Allergies");
    await expect(peek).toContainText(allergy);
    const [viewed] = await localSql<{ n: number }>(
      `select count(*)::int as n from app.work_detail_events
        where roster_entry_id = $1 and action = 'work_details.viewed'`,
      [entryOne],
    );
    expect(viewed?.n ?? 0).toBeGreaterThan(0);
  } finally {
    for (const engagement of engagements) {
      await localSql(
        `update app.work_detail_shares set revoked_at = coalesce(revoked_at, now()), deleted_at = now()
          where engagement_id = $1 and deleted_at is null`,
        [engagement],
      );
      await localSql(
        `update app.engagement_roster_entries set deleted_at = now()
          where engagement_id = $1 and deleted_at is null`,
        [engagement],
      );
      await localSql("update app.engagements set deleted_at = now() where id = $1", [engagement]);
    }
    if (details?.id) {
      await localSql("update app.person_work_details set allergies = $2 where id = $1", [
        details.id,
        details.allergies,
      ]);
    } else {
      await localSql(
        `update app.person_work_details set deleted_at = now()
          where person_id = $1 and allergies = $2 and deleted_at is null`,
        [AGENCY.staffOne, allergy],
      );
    }
  }
});
