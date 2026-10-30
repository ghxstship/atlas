import { toDisplayKey } from "@xos/data/gateway-keys";
import { expect as baseExpect, test } from "./engine-test";
import { asPerson, offer, PEOPLE } from "./role-fixtures";
import { DEMO, signIn, sql } from "./support";

/**
 * R5 (RRR-184, owner decisions 0/1, 3, 4 and 6; parity G-142): project facts and the names lock in Gateway.
 *   - A freelance crew member fills the Project details wizard (travel, uniform sizes, vehicle) on their engagement.
 *     The tab shows only while travel, uniforms or parking is offered.
 *   - A staffing agency's Account Owner (seed 1080) sees a member's chips on the Crew tab, opens Project details and,
 *     with the org's setting on, enters the member's vehicle; the member is notified.
 *   - The producing org sets a names lock: the Crew tab says when names lock, and once it has passed Add and Invite
 *     close, while a Returned entry is still submitted again.
 * Each test runs on a project of its own, so the demo project's offerings stay as the seed left them, and removes
 * what it made afterwards.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const AGENCY = {
  owner: "01920000-0000-7000-8000-000010800101",
  staffOne: "01920000-0000-7000-8000-000010800102",
  account: "01920000-0000-7000-8000-000010800301",
} as const;

/** Two to five capital letters (projects_key_format): F and four random letters. */
function projectKey(): string {
  const letters = Array.from({ length: 4 }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26)),
  ).join("");
  return `F${letters}`;
}

async function newProject(name: string): Promise<{ id: string; key: string }> {
  const key = projectKey();
  const [project] = await sql<{ id: string }>(
    `insert into app.projects (org_id, project_key, name, time_zone)
     values ($1, $2, $3, 'America/New_York') returning id`,
    [DEMO.org, key, `${name} ${key}`],
    PEOPLE.owner,
  );
  return { id: project?.id as string, key };
}

/** Soft-deletes the project and what the journey added there, which frees the project key too. */
async function removeProject(projectId: string): Promise<void> {
  for (const statement of [
    `update app.engagement_roster_entries set deleted_at = now()
      where engagement_id in (select id from app.engagements where project_id = $1) and deleted_at is null`,
    "update app.engagements set roster_locks_at = null where project_id = $1",
    `update app.setting_values set deleted_at = now()
      where scope_kind = 'Project' and scope_id = $1 and deleted_at is null`,
    "update app.engagements set deleted_at = now() where project_id = $1 and deleted_at is null",
    "update app.projects set deleted_at = now() where id = $1 and deleted_at is null",
  ]) {
    await sql(statement, [projectId]);
  }
}

async function count(text: string, params: unknown[]): Promise<number> {
  const [row] = await sql<{ n: number }>(text, params);
  return row?.n ?? 0;
}

test("project details: a crew member's wizard, and the tab follows the offerings", async ({
  page,
}) => {
  const project = await newProject("Project Facts Run");
  try {
    for (const key of ["offerings.travel", "offerings.uniforms", "offerings.parking"] as const) {
      await offer(key, project.id);
    }
    const [engagement] = await sql<{ id: string }>(
      `insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis,
         arrangement, agreed_rate_minor, currency_code, start_date, end_date)
       values ($1, $2, 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 90000, 'USD',
         '2027-06-04', '2027-06-06')
       returning id`,
      [project.id, DEMO.crew],
      PEOPLE.owner,
    );
    const engagementId = engagement?.id as string;
    const key = toDisplayKey("engagement", engagementId);
    const tabs = page.getByRole("navigation", { name: "Engagement sections" });

    await signIn(page, "crew@example.com", `/work/engagements/${key}/project-details`);
    const wizard = page.locator("[data-template=wizard]");
    await expect(wizard.getByRole("heading", { name: /Project details for/ })).toBeVisible();

    // Travel: airports by code, the dates, a pickup.
    await wizard.getByRole("combobox", { name: "Arriving at" }).fill("MIA");
    await page.getByRole("option", { name: /\(MIA\)/ }).click();
    await wizard.getByLabel("Arrival date").fill("2027-06-03");
    await wizard.getByRole("combobox", { name: "Flying home from" }).fill("MIA");
    await page.getByRole("option", { name: /\(MIA\)/ }).click();
    await wizard.getByLabel("Departure date").fill("2027-06-07");
    await wizard.getByLabel("I need a pickup on arrival").check();
    await wizard.getByRole("button", { name: "Next" }).click();

    // Uniform sizes.
    await expect(wizard.getByRole("form", { name: "Uniform" })).toBeVisible();
    await wizard.getByLabel("Shirt").selectOption("M");
    await wizard.getByRole("button", { name: "Next" }).click();

    // Vehicle: the plate is stored without spaces, uppercased.
    await expect(wizard.getByRole("form", { name: "Vehicle" })).toBeVisible();
    await wizard.getByLabel("Make").fill("Ford");
    await wizard.getByLabel("Model").fill("Transit");
    await wizard.getByLabel("License plate").fill("abc 123");
    await wizard.getByLabel("Plate region").fill("US-FL");
    await wizard.getByRole("button", { name: "Next" }).click();

    await expect(wizard).toContainText("ABC123");
    await expect(wizard).toContainText("Miami International Airport (MIA)");
    const [rows] = await sql<{ travel: number; uniform: number; vehicle: number }>(
      `select (select count(*)::int from app.roster_travel_requests t where t.roster_entry_id = r.id and t.deleted_at is null) as travel,
              (select count(*)::int from app.roster_uniform_sizes u where u.roster_entry_id = r.id and u.deleted_at is null) as uniform,
              (select count(*)::int from app.roster_vehicles v where v.roster_entry_id = r.id and v.deleted_at is null) as vehicle
         from app.engagement_roster_entries r where r.engagement_id = $1 and r.deleted_at is null`,
      [engagementId],
    );
    expect(rows).toEqual({ travel: 1, uniform: 1, vehicle: 1 });
    // Nothing reaches the profile.
    expect(
      await count(
        `select count(*)::int as n from app.person_work_details
          where person_id = $1 and shirt_size = 'M' and updated_at > now() - interval '5 minutes'`,
        [DEMO.crew],
      ),
    ).toBe(0);

    // With travel, uniforms and parking off the tab is gone, and its route answers 404.
    for (const k of ["offerings.travel", "offerings.uniforms", "offerings.parking"] as const) {
      await offer(k, project.id, "not-offered");
    }
    await page.goto(`/work/engagements/${key}`);
    await expect(tabs.getByRole("link", { name: "Shifts" })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "Project Details" })).toHaveCount(0);
    expect((await page.goto(`/work/engagements/${key}/project-details`))?.status()).toBe(404);
  } finally {
    await removeProject(project.id);
  }
});

test("crew tab: the company enters a member's vehicle, and the names lock", async ({
  page,
  browser,
}) => {
  const project = await newProject("Names Lock Run");
  try {
    await offer("offerings.parking", project.id);
    await asPerson(
      PEOPLE.owner,
      `select app.set_setting($1, 'advancing.company_may_submit_project_facts', 'Project', $2, null, true, null, false)`,
      [DEMO.org, project.id],
    );
    const [engagement] = await sql<{ id: string }>(
      `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
         pay_basis, arrangement, agreed_rate_minor, currency_code, start_date, end_date)
       values ($1, $2,
         (select c.id from app.counterparties c where c.org_id = $3 and c.organization_id = $4 and c.deleted_at is null limit 1),
         'Staff', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 30000, 'USD', '2027-06-04', '2027-06-06')
       returning id`,
      [project.id, AGENCY.owner, DEMO.org, AGENCY.account],
      PEOPLE.owner,
    );
    const engagementId = engagement?.id as string;
    const [entry] = await asPerson<{ id: string }>(
      AGENCY.owner,
      "select app.add_roster_entry($1, $2) as id",
      [engagementId, AGENCY.staffOne],
    );
    const entryId = entry?.id as string;
    await asPerson(AGENCY.owner, "select app.submit_roster($1)", [engagementId]);
    await asPerson(AGENCY.staffOne, "select app.respond_roster_entry($1, 'Accepted')", [entryId]);
    const crewPath = `/work/engagements/${toDisplayKey("engagement", engagementId)}/crew`;

    await signIn(page, "agency@example.com", "/home");
    await page
      .context()
      .addCookies([{ name: "xos-acting", value: AGENCY.account, url: page.url() }]);
    await page.goto(crewPath);
    const row = page.getByRole("listitem").filter({ hasText: "Demo Staff One" });
    await expect(row.getByText("Vehicle: Missing")).toBeVisible();

    // Project details reads the member's facts once, logged; the Owner enters the vehicle for them.
    await row.getByRole("button", { name: "Project details" }).click();
    const drawer = page.getByRole("dialog", { name: "Project details for Demo Staff One" });
    await drawer.getByRole("button", { name: "Enter for Demo Staff One" }).click();
    await expect(drawer).toContainText("Demo Staff One will be notified");
    await drawer.getByLabel("Make").fill("Ford");
    await drawer.getByLabel("Model").fill("Transit");
    await drawer.getByLabel("License plate").fill("FLY 42");
    await drawer.getByLabel("Plate region").fill("US-FL");
    await drawer.getByRole("button", { name: "Next" }).click();
    await expect(drawer).toContainText("FLY42");
    await expect
      .poll(() =>
        count(
          `select count(*)::int as n from app.notifications
            where kind = 'roster_entry.project_facts_entered' and recipient_person_id = $1 and subject_id = $2`,
          [AGENCY.staffOne, entryId],
        ),
      )
      .toBe(1);
    expect(
      await count(
        `select count(*)::int as n from app.work_detail_events
          where roster_entry_id = $1 and action = 'project_facts.viewed'`,
        [entryId],
      ),
    ).toBeGreaterThan(0);

    // The member's access log in Gateway lists the company's read.
    const member = await browser.newContext({ reducedMotion: "reduce" });
    const memberPage = await member.newPage();
    await signIn(memberPage, "staff.one@example.com", "/settings/work-details");
    await expect(
      memberPage
        .getByRole("region", { name: "Access log" })
        .getByText("Viewed your project details")
        .first(),
    ).toBeVisible();
    await member.close();

    // A names lock ahead: the tab says when names lock.
    await asPerson(PEOPLE.owner, "select app.set_roster_lock($1, now() + interval '3 days')", [
      engagementId,
    ]);
    await page.goto(crewPath);
    await expect(page.getByText(/^Names lock on /)).toBeVisible();

    // Once it has passed, Add and Invite close; a Returned entry is still submitted again.
    await asPerson(PEOPLE.owner, "select app.set_roster_lock($1, now() - interval '1 minute')", [
      engagementId,
    ]);
    await asPerson(
      PEOPLE.owner,
      "select app.review_roster_entry($1, 'Returned', 'Add the arrival window.')",
      [entryId],
    );
    await page.goto(crewPath);
    await expect(page.getByText(/^Names locked on /).first()).toBeVisible();
    await expect(page.getByRole("form", { name: "Add someone from your team" })).toHaveCount(0);
    await expect(page.getByRole("form", { name: "Invite someone by email" })).toHaveCount(0);
    await page.getByRole("button", { name: "Submit roster (1 entry)" }).click();
    await expect
      .poll(() =>
        count(
          `select count(*)::int as n from app.engagement_roster_entries
            where id = $1 and entry_state = 'Submitted'`,
          [entryId],
        ),
      )
      .toBe(1);
  } finally {
    await removeProject(project.id);
  }
});
