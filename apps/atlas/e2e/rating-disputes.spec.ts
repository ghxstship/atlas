import pg from "pg";
import { expect, test } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { expectAccessible } from "./support";

const databaseUrl =
  process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
const OWNER = "01920000-0000-7000-8000-000000000101";
const CREW = "01920000-0000-7000-8000-000000000201";
const PROJECT = "01920000-0000-7000-8000-000000001001";

async function sql<T extends Record<string, unknown>>(
  text: string,
  params: unknown[],
  person: string,
): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: person, role: "authenticated" }),
    ]);
    const result = await client.query(text, params);
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
 * ADR 0158: a person the org rated disputes the rating. The org that gave it sees the dispute on its Ratings page and answers
 * once. It has no way to remove the rating or decide the dispute itself; a platform operator does that in the console.
 */
test("the org answers a dispute of its rating, once, and cannot decide it", async ({ page }) => {
  const tag = Date.now().toString(36).slice(-5);
  const details = `The call sheet shows I was on time ${tag}.`;
  const answer = `Our gate log says 07:40 ${tag}.`;
  const [engagement] = await sql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement,
       start_date, end_date)
     values ($1, $2, 'Staff', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-02-10', '2027-02-12')
     returning id`,
    [PROJECT, CREW],
    OWNER,
  );
  for (const [from, to] of [
    ["Onboarding", "Active"],
    ["Active", "Closing"],
    ["Closing", "Complete"],
  ] as const) {
    await sql(
      `select private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
         'engagement_id', $1::uuid, $2, $3, 'Journey fixture.')`,
      [engagement?.id, from, to],
      OWNER,
    );
  }
  const [rating] = await sql<{ id: string }>(
    `insert into app.ratings (engagement_id, rater_side, score, comment) values ($1, 'Organization', 2, $2) returning id`,
    [engagement?.id, `Late to the call ${tag}.`],
    OWNER,
  );
  await sql(
    `insert into app.ratings (engagement_id, rater_side, score) values ($1, 'Party', 4)`,
    [engagement?.id],
    CREW,
  );
  await sql(
    `select app.file_rating_dispute($1, 'False Statement', $2)`,
    [rating?.id, details],
    CREW,
  );

  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/opportunities/ratings?view=list`);
  const section = page.getByRole("region", { name: "Disputes of your ratings" });
  const item = section.getByRole("listitem").filter({ hasText: details });
  await expect(item).toBeVisible();
  await expect(item.getByText("Says it is false", { exact: false })).toBeVisible();
  // The org can tell which rating it is answering for.
  await expect(item.getByRole("link")).toHaveAttribute("href", new RegExp(`id=${engagement?.id}`));
  await expect(
    item.getByText(`Your rating: 2 stars. Late to the call ${tag}.`, { exact: true }),
  ).toBeVisible();
  await expectAccessible(page);

  await item.getByLabel("Your answer", { exact: true }).fill(answer);
  await item.getByRole("button", { name: "Send answer" }).click();
  await expect(item.getByText(`Your answer: ${answer}`, { exact: true })).toBeVisible();
  await expect(item.getByRole("button", { name: "Send answer" })).toHaveCount(0);

  // The rating is still there, and nothing here decides or removes it.
  await expect(page.getByText(`Late to the call ${tag}.`, { exact: true })).toBeVisible();
  await expect(item.getByRole("button", { name: /uphold|remove|decide/i })).toHaveCount(0);
});
