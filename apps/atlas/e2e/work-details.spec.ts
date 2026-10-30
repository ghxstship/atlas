import pg from "pg";
import { expect as baseExpect, test } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { cognitiveLoadProblems } from "./a11y/checks";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

// Each save is a server action that renders Settings again; a dev server compiles it on first use.
const expect = baseExpect.configure({ timeout: 20_000 });

/**
 * Work Details in Atlas (A78, finding A65-003, migration 1340): a new member fills in Settings,
 * Work Details. An emergency contact typed in national format is stored in E.164 and shown back in
 * national format (Section 15); dietary needs and allergies save and read back; uniform sizes and
 * travel preferences are asked per project since R6a, which a notice says; the passport number
 * shows only its last four until the explicit reveal, which the access log records; the page stays
 * axe clean and within the cognitive load gate (one primary action, at most seven fields per form,
 * gate 27). Settings, Profile takes the optional given and family names.
 */
test("Work Details: a member records their details and reveals the passport number", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const id = uniqueId();
  const slug = `details-${id}`;
  await signUp(page, { name: "Wren Details", email: testEmail("details", id) });
  await createOrganization(page, { name: `Details ${id}`, slug });

  await page.goto(`/${slug}/me/work-details`);
  await expect(page.getByRole("heading", { name: "Emergency contacts" })).toBeVisible();
  await expect(page.getByText("No emergency contacts yet.")).toBeVisible();
  await expect(
    page.getByText("Uniform sizes and travel preferences moved to each project"),
  ).toBeVisible();
  await expect(page.getByRole("form", { name: "Uniform sizes" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Loyalty programs" })).toBeVisible();
  await expect(page.getByLabel("Home airport")).toHaveCount(0);
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await expectAccessible(page);

  const add = page.getByRole("form", { name: "Add contact" });
  await add.getByLabel("Name").fill("Robin Example");
  await add.getByLabel("Relationship").fill("Partner");
  await add.getByLabel("Phone", { exact: true }).fill("not a number");
  await add.getByRole("button", { name: "Add contact" }).click();
  await expect(add.getByText(/Enter a phone number with its country code/)).toBeVisible();
  await add.getByLabel("Phone", { exact: true }).fill("(305) 555-0142");
  await add.getByRole("button", { name: "Add contact" }).click();
  const contact = page.getByRole("listitem").filter({ hasText: "Robin Example" });
  await expect(contact).toContainText("(305) 555-0142");

  const dietary = page.getByRole("form", { name: "Dietary needs" });
  await dietary.getByRole("button", { name: /^Dietary needs/ }).click();
  await dietary.getByLabel("Vegan").check();
  await dietary.getByLabel("Allergies").fill("Peanuts, anaphylaxis");
  await dietary.getByRole("button", { name: "Save dietary needs" }).click();
  await expect(dietary.getByRole("status")).toHaveText("Saved.");
  // Allergies are Restricted (R6a): the person reads their own back through app.my_allergies.
  await page.reload();
  await expect(
    page.getByRole("form", { name: "Dietary needs" }).getByLabel("Allergies"),
  ).toHaveValue("Peanuts, anaphylaxis");

  const passport = page.getByRole("form", { name: "Passport" });
  await passport.getByLabel("Passport number").fill("TEST-123456");
  await passport.getByRole("button", { name: "Save passport details" }).click();
  await expect(passport.getByRole("status")).toHaveText("Saved.");
  await page.reload();
  await expect(page.getByText("Number on file ending 3456")).toBeVisible();
  const reveal = page.getByRole("form", { name: "Reveal number" });
  await reveal.getByRole("button", { name: "Reveal number" }).click();
  await expect(reveal.getByRole("status")).toHaveText("Passport number: TEST123456");

  await page.reload();
  const log = page.getByRole("region", { name: "Access log" });
  await expect(log.getByText(/Passport number revealed/).first()).toBeVisible();
  await expect(log.getByText(/Emergency contact added/).first()).toBeVisible();
  await expect(log).not.toContainText("TEST123456");
  await expect(page.getByText("You have no engagements to share with yet.")).toBeVisible();

  await page.goto(`/${slug}/me/profile`);
  const names = page.getByRole("form", { name: "Name parts" });
  await names.getByLabel("Given name").fill("Wren");
  await names.getByLabel("Family name").fill("Details");
  await names.getByRole("button", { name: "Save name parts" }).click();
  await expect(names.getByRole("status")).toHaveText("Saved.");
  await expectAccessible(page);
});

// Restricted allergies (R6a, migrations 2662 and 2663) -------------------------------------------------

const DEMO_OWNER = "01920000-0000-7000-8000-000000000101";
const DEMO_ADMIN = "01920000-0000-7000-8000-000000000102";
const DEMO_CREW = "01920000-0000-7000-8000-000000000201";
const DEMO_PROJECT = "01920000-0000-7000-8000-000000001001";
const CREW_ENGAGEMENT = "01920000-0000-7000-8000-000000228401";

/** One statement as postgres against the local stack only, under `person`'s claims when given. */
async function localSql<T extends Record<string, unknown>>(
  text: string,
  args: unknown[] = [],
  person?: string,
): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error(
      "The restricted allergies journey assigns roles only on a local Supabase stack.",
    );
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

/**
 * The demo Admin reads hospitality on the demo project but holds no medical capability, so the crew
 * person's shared allergies (seed 1340) show locked. Once the Owner makes the Admin the Event medical
 * role (7000.51.01) on the project, the value shows with the Medical block, and the crew person's
 * access log records an allergies.viewed entry naming the Admin. The crew person is external, so
 * their Access log is in Gateway, whose work-details journey asserts its "Allergies viewed" line.
 */
test("Work Details: allergies show to on-site medical only, and each read is logged", async ({
  page,
}) => {
  test.setTimeout(180_000);
  let assignment: string | null = null;
  try {
    await signInAs(page, "admin@example.com", DEMO_ORG);
    await page.goto(`/${DEMO_ORG}/opportunities/engagements?id=${CREW_ENGAGEMENT}`);
    const shared = page.getByRole("region", { name: "Shared work details" });
    await expect(shared.getByRole("heading", { name: "Dietary needs" })).toBeVisible();
    await expect(shared).toContainText("Restricted: medical access only");
    await expect(shared).not.toContainText("Shellfish, mild");
    await expect(shared.getByRole("heading", { name: "Medical" })).toHaveCount(0);

    // Someone else assigns the Admin on-site medical on the project: nobody grants it to themselves.
    const [row] = await localSql<{ id: string }>(
      `insert into app.role_assignments (project_id, role_code, person_id)
       values ($1, '7000.51.01', $2) returning id`,
      [DEMO_PROJECT, DEMO_ADMIN],
      DEMO_OWNER,
    );
    assignment = row?.id ?? null;
    await localSql(
      "select app.transition_role_assignment($1, 'Proposed', 'Active', 'On the medical tent.')",
      [assignment],
      DEMO_OWNER,
    );

    await page.reload();
    await expect(shared).toContainText("Shellfish, mild");
    await expect(shared.getByRole("heading", { name: "Medical" })).toBeVisible();
    await expectAccessible(page);
    const [viewed] = await localSql<{ n: number }>(
      `select count(*)::int as n from app.work_detail_events
        where person_id = $1 and action = 'allergies.viewed' and actor_person_id = $2`,
      [DEMO_CREW, DEMO_ADMIN],
    );
    expect(viewed?.n ?? 0).toBeGreaterThan(0);
  } finally {
    if (assignment) {
      await localSql("update app.role_assignments set deleted_at = now() where id = $1", [
        assignment,
      ]);
    }
  }
});
