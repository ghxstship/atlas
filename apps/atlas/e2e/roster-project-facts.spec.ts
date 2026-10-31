import { expect as baseExpect, test } from "@playwright/test";
import pg from "pg";
import { DEMO_ORG, signInAs } from "./a36-support";

/**
 * R5 (RRR-184, owner decision 4; parity G-142 and G-175) in Atlas, on a project of its own with the staffing agency of
 * seed 1080 (Account Owner agency@example.com, accepted member Demo Staff One):
 *   - a reader whose only capabilities are advancing.packet.read and hospitality.fulfillment.read opens an entry's
 *     peek in Crew review: travel shows, and uniform shows a refusal naming the capability; the read is logged in the
 *     person's access log;
 *   - the demo Owner sets a names lock from the party's header;
 *   - a hospitality coordinator (advancing.packet.read, hospitality.fulfillment.read and hospitality.accommodation.write
 *     only) opens Travel party, sees Room Missing for a person who needs lodging, assigns a room from the prefilled row
 *     and the chip turns Assigned.
 * The agency builds its roster and the person enters their facts through the same RPCs Gateway calls, as postgres on
 * the local stack under their claims. The run removes its project, people and rows afterwards.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const DEMO_ORG_ID = "01920000-0000-7000-8000-000000000001";
const DEMO_OWNER = "01920000-0000-7000-8000-000000000101";
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
    throw new Error("The project facts journey builds its rows only on a local Supabase stack.");
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

/** Two to five capital letters (projects_key_format): T and four random letters. */
function projectKey(): string {
  return `T${Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("")}`;
}

/** A sign-in with the shared demo password whose only org role, `roleName`, holds the given capabilities. */
async function member(
  email: string,
  fullName: string,
  roleName: string,
  capabilities: readonly string[],
  projectId: string,
) {
  await localSql(
    `with u as (
       insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token,
         email_change_token_new, email_change)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', $1,
         extensions.crypt('xos-demo-2026', extensions.gen_salt('bf')), now(),
         '{"provider": "email", "providers": ["email"]}'::jsonb, jsonb_build_object('full_name', $2::text),
         now(), now(), '', '', '', '')
       returning id, email)
     insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at)
     select u.id, u.id, u.id::text, 'email', jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       now(), now() from u`,
    [email, fullName],
  );
  const [person] = await localSql<{ id: string }>(
    `update app.people p set id = p.user_id from auth.users u
      where u.id = p.user_id and u.email = $1 returning p.id`,
    [email],
  );
  const personId = person?.id as string;
  const [role] = await localSql<{ id: string }>(
    `insert into app.roles (org_id, code, name, band, description)
     values ($1, $2, $3, 4, $4) returning id`,
    [
      DEMO_ORG_ID,
      `hosp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      roleName,
      `Holds ${capabilities.join(", ")} only.`,
    ],
  );
  for (const capability of capabilities) {
    await localSql(
      `insert into app.role_capabilities (role_id, capability_code, reach) values ($1, $2, 'organization')`,
      [role?.id, capability],
    );
  }
  const [invite] = await localSql<{ token: string }>(
    "select i.invite_token as token from app.invite_member($1, $2, $3) i",
    [DEMO_ORG_ID, email, role?.id],
    DEMO_OWNER,
  );
  await localSql("select app.accept_invite($1)", [invite?.token], personId);
  await localSql(
    `insert into app.project_members (project_id, membership_id, project_role)
     select $1, m.id, 'Field' from app.memberships m
      where m.org_id = $2 and m.person_id = $3 and m.deleted_at is null`,
    [projectId, DEMO_ORG_ID, personId],
  );
  return personId;
}

test("project facts in Atlas: the logged peek, the names lock and the travel party", async ({
  page,
  browser,
}) => {
  const key = projectKey();
  const [project] = await localSql<{ id: string }>(
    `insert into app.projects (org_id, project_key, name, time_zone)
     values ($1, $2, $3, 'America/New_York') returning id`,
    [DEMO_ORG_ID, key, `Travel Party Run ${key}`],
    DEMO_OWNER,
  );
  const projectId = project?.id as string;
  const readerEmail = `hosp-reader-${key.toLowerCase()}@example.com`;
  const coordinatorEmail = `hosp-coordinator-${key.toLowerCase()}@example.com`;
  try {
    for (const offering of ["travel", "lodging", "uniforms"]) {
      await localSql(
        `select app.set_setting($1, $2, 'Project', $3, 'provided', null, null, false)`,
        [DEMO_ORG_ID, `offerings.${offering}`, projectId],
        DEMO_OWNER,
      );
    }
    const [engagement] = await localSql<{ id: string }>(
      `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
         pay_basis, arrangement, agreed_rate_minor, currency_code, start_date, end_date)
       values ($1, $2,
         (select c.id from app.counterparties c where c.org_id = $3 and c.organization_id = $4 and c.deleted_at is null limit 1),
         'Staff', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 30000, 'USD', '2027-06-04', '2027-06-06')
       returning id`,
      [projectId, AGENCY.owner, DEMO_ORG_ID, AGENCY.account],
      DEMO_OWNER,
    );
    const engagementId = engagement?.id as string;
    const [entry] = await localSql<{ id: string }>(
      "select app.add_roster_entry($1, $2) as id",
      [engagementId, AGENCY.staffOne],
      AGENCY.owner,
    );
    const entryId = entry?.id as string;
    await localSql("select app.submit_roster($1)", [engagementId], AGENCY.owner);
    await localSql("select app.respond_roster_entry($1, 'Accepted')", [entryId], AGENCY.staffOne);
    // The person asks for a room for three nights and enters their sizes.
    await localSql(
      `select app.save_roster_travel_request($1, 'MIA', 'MIA', '2027-06-03', '2027-06-06', null, null, false, true, null)`,
      [entryId],
      AGENCY.staffOne,
    );
    await localSql(
      `select app.save_roster_uniform_sizes($1, 'M', null, null, null, null, null, null, null, null)`,
      [entryId],
      AGENCY.staffOne,
    );
    await localSql(
      `insert into app.accommodation_blocks (org_id, project_id, title, check_in_on, check_out_on, rooms_held)
       values ($1, $2, 'Hotel Cadillac', '2027-06-01', '2027-06-10', 10)`,
      [DEMO_ORG_ID, projectId],
      DEMO_OWNER,
    );
    const [party] = await localSql<{ name: string }>(
      "select name from app.organizations where id = $1",
      [AGENCY.account],
    );
    const partyName = party?.name ?? "";
    const crew = `/${DEMO_ORG}/p/${key}/advancing?section=crew`;

    // A hospitality reader reads travel in the peek; uniform is refused by name. The read is logged.
    await member(
      readerEmail,
      "Demo Hospitality Reader",
      "Hospitality Reader",
      ["advancing.packet.read", "hospitality.fulfillment.read"],
      projectId,
    );
    const readerContext = await browser.newContext({ reducedMotion: "reduce" });
    const readerPage = await readerContext.newPage();
    await signInAs(readerPage, readerEmail, DEMO_ORG);
    await readerPage.goto(`${crew}&peek=${entryId}`);
    const facts = readerPage.getByRole("region", { name: "Project details" });
    await expect(facts).toContainText("Miami International Airport (MIA)");
    await expect(
      facts.getByRole("status").filter({ hasText: "opportunities.engagement.read" }),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const [row] = await localSql<{ n: number }>(
          `select count(*)::int as n from app.work_detail_events
            where roster_entry_id = $1 and action = 'project_facts.viewed' and 'Travel' = any (fact_kinds)`,
          [entryId],
        );
        return row?.n ?? 0;
      })
      .toBeGreaterThan(0);
    await readerContext.close();

    // The Owner sets a names lock from the party's header.
    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(crew);
    const header = page.getByRole("region", { name: partyName });
    await expect(header.getByText("No names lock")).toBeVisible();
    await header.getByRole("button", { name: "Set names lock" }).click();
    const dialog = page.getByRole("dialog", { name: `Names lock for ${partyName}` });
    await dialog.getByLabel("Names lock at").fill("2027-05-20T18:00");
    await dialog.getByRole("button", { name: "Save lock" }).click();
    await expect(dialog).toBeHidden();
    await expect(header.getByText(/^Names lock /)).toBeVisible();
    const [locked] = await localSql<{ at: string }>(
      "select roster_locks_at::text as at from app.engagements where id = $1",
      [engagementId],
    );
    expect(locked?.at).toContain("2027-05-20 22:00:00");

    // Travel party, as a hospitality coordinator: the room is missing; assigning it from the prefilled row turns the
    // chip Assigned.
    await member(
      coordinatorEmail,
      "Demo Hospitality Coordinator",
      "Hospitality Coordinator",
      ["advancing.packet.read", "hospitality.fulfillment.read", "hospitality.accommodation.write"],
      projectId,
    );
    const coordinatorContext = await browser.newContext({ reducedMotion: "reduce" });
    const coordinator = await coordinatorContext.newPage();
    await signInAs(coordinator, coordinatorEmail, DEMO_ORG);
    await coordinator.goto(`/${DEMO_ORG}/p/${key}/advancing?section=travel-party`);
    const row = coordinator.getByRole("row").filter({ hasText: "Demo Staff One" });
    await expect(row).toContainText("Missing");
    await row.getByRole("link", { name: "Assign room" }).click();
    const drawer = coordinator.getByRole("dialog", { name: "Assign room" });
    await expect(drawer.getByLabel("Check-in")).toHaveValue("2027-06-03");
    await drawer.getByRole("button", { name: "Assign room" }).click();
    await expect(coordinator.getByRole("row").filter({ hasText: "Demo Staff One" })).toContainText(
      "Assigned",
    );
    await coordinatorContext.close();
  } finally {
    for (const statement of [
      `update app.accommodation_assignments set deleted_at = now()
        where accommodation_block_id in (select id from app.accommodation_blocks where project_id = $1) and deleted_at is null`,
      "update app.accommodation_blocks set deleted_at = now() where project_id = $1 and deleted_at is null",
      `update app.engagement_roster_entries set deleted_at = now()
        where engagement_id in (select id from app.engagements where project_id = $1) and deleted_at is null`,
      `update app.setting_values set deleted_at = now()
        where scope_kind = 'Project' and scope_id = $1 and deleted_at is null`,
      "update app.engagements set deleted_at = now() where project_id = $1 and deleted_at is null",
      "update app.project_members set deleted_at = now() where project_id = $1 and deleted_at is null",
      "update app.projects set deleted_at = now() where id = $1 and deleted_at is null",
    ]) {
      await localSql(statement, [projectId]);
    }
  }
});
