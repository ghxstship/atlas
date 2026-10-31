import { expect as baseExpect, test } from "./engine-test";
import {
  asPerson,
  PEOPLE,
  ROLE_ACCOUNTS,
  ROLE_PEOPLE,
  roleEngagement,
  suffix,
} from "./role-fixtures";
import { DEMO, expectAccessible, signIn, sql } from "./support";

/**
 * B3 client cue fields (RRR-227, ADR 0142; gap G-73): the producer gives the run of show two cue fields, one for
 * the Client and one kept with the crew. The client reads the Client field beside its cue in Gateway's run of
 * show and never the crew one, on screen or through the database (api_external.cue_field_values).
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

async function cueField(key: string, label: string, sortOrder: number): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, required, sort_order)
     values ($1, 'app.cues', $2, $3, 'Text', false, $4) returning id`,
    [DEMO.org, key, label, sortOrder],
    PEOPLE.owner,
  );
  if (!row) throw new Error(`cue field ${key} was not created`);
  return row.id;
}

test("the client sees the Client cue field and never a crew-only one", async ({ page }) => {
  const engagement = await roleEngagement({
    person: ROLE_PEOPLE.client,
    account: ROLE_ACCOUNTS.client,
    roleType: "Client",
  });
  const id = suffix();
  const shared = await cueField(`client_note_${id.toLowerCase()}`, `Client note ${id}`, 900);
  const crewOnly = await cueField(`crew_note_${id.toLowerCase()}`, `Crew note ${id}`, 901);
  try {
    // Each new cue field starts with the Crew audience (2920); the first also goes to the Client.
    await sql(
      `insert into app.cue_field_audiences (org_id, custom_field_definition_id, audience) values ($1, $2, 'Client')`,
      [DEMO.org, shared],
      PEOPLE.owner,
    );
    const [cue] = await sql<{ id: string }>(
      `select c.id from app.cues c join app.run_of_show r on r.id = c.run_of_show_id
        where r.project_id = $1 and r.deleted_at is null and c.deleted_at is null and c.label = 'House Lights Up'
        order by r.show_date, c.position limit 1`,
      [DEMO.project],
    );
    if (!cue) throw new Error("the demo run of show has no House Lights Up cue");
    for (const [definition, text] of [
      [shared, "Confetti on the final chorus"],
      [crewOnly, "Wardrobe swap stage left"],
    ] as const) {
      await sql(
        `insert into app.custom_field_values (custom_field_definition_id, target_id, value_text) values ($1, $2, $3)`,
        [definition, cue.id, text],
        PEOPLE.owner,
      );
    }

    await signIn(page, "client@example.com", `/work/engagements/${engagement.key}/run-of-show`);
    const row = page.getByRole("listitem").filter({ hasText: "House Lights Up" }).first();
    await expect(row).toContainText(`Client note ${id}: Confetti on the final chorus`);
    await expect(page.getByText(`Crew note ${id}`)).toHaveCount(0);
    await expect(page.getByText("Wardrobe swap stage left")).toHaveCount(0);
    await expectAccessible(page);

    // The database gives the client the Client field only.
    const rows = await asPerson<{ label: string }>(
      ROLE_PEOPLE.client,
      `select label from api_external.cue_field_values where cue_id = $1`,
      [cue.id],
    );
    expect(rows.map((r) => r.label)).toEqual([`Client note ${id}`]);
  } finally {
    await sql(
      `update app.custom_field_definitions set deleted_at = now() where id = any($1::uuid[])`,
      [[shared, crewOnly]],
    );
  }
});
