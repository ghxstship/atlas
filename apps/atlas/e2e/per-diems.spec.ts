import pg from "pg";
import { expect, test } from "./engine-test";
import { expectAccessibleInBothThemes, ORG, signIn } from "./operations-support";

/**
 * Crew > Per Diems (R1, RRR-179) on the demo tenant seed: the Producer adds three days of per diem for
 * an engaged crew person who is not a member (app.add_per_diems), the days list on the page, and one is
 * removed. The engagement is made for the run and canceled afterwards, so runs never collide.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
expect.configure({ timeout: 20_000 });

const PROJECT = "01920000-0000-7000-8000-000000001001";
const CREW = "01920000-0000-7000-8000-000000000201";
const PRODUCER = "01920000-0000-7000-8000-000000000103";

async function localSql<T extends pg.QueryResultRow>(
  text: string,
  args: unknown[] = [],
): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: PRODUCER, role: "authenticated" }),
    ]);
    const result = await client.query<T>(text, args);
    await client.query("commit");
    return result.rows;
  } finally {
    await client.end();
  }
}

async function move(id: string, from: string, to: string, reason: string) {
  await localSql(
    `select private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state',
       'app.engagement_state_transitions', 'engagement_id', $1, $2, $3, $4)`,
    [id, from, to, reason],
  );
}

test("per diems: three days for an engaged crew person, then one removed", async ({ page }) => {
  const [engagement] = await localSql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis,
       arrangement, start_date)
     values ($1, $2, 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-09-01')
     returning id`,
    [PROJECT, CREW],
  );
  const id = engagement?.id as string;
  // The demo seed's blocking Crew requirement (Certificate of Insurance) passes, as seed 1490 does for its
  // crew engagement, so the engagement can go Active.
  await localSql(
    `update app.onboarding_items set submitted_at = now() where engagement_id = $1 and deleted_at is null`,
    [id],
  );
  await localSql(
    `insert into app.onboarding_verifications (onboarding_item_id, outcome, verified_at, expires_on, note)
     select i.id, 'Passed', now(), date '2028-06-30', 'Checked by the per diem journey.'
     from app.onboarding_items i where i.engagement_id = $1 and i.deleted_at is null`,
    [id],
  );
  await move(id, "Onboarding", "Active", "Per diem journey.");
  try {
    await signIn(page, "producer@example.com");
    await page.goto(`/${ORG}/crew/per-diems?project=NWS`);
    await expect(page.getByRole("heading", { level: 1, name: "Per Diems" })).toBeVisible();
    await expectAccessibleInBothThemes(page);

    await page.getByRole("link", { name: "Add per diems" }).first().click();
    const drawer = page.getByRole("dialog", { name: "Add per diems" });
    await drawer.getByLabel("Person").selectOption({ label: "Demo Crew Member · Crew" });
    await drawer.getByLabel("First day").fill("2027-09-02");
    await drawer.getByLabel("Last day").fill("2027-09-04");
    await drawer.getByLabel("Amount per day").fill("65");
    await drawer.getByLabel("Currency").selectOption("USD");
    await drawer.getByRole("button", { name: "Add per diems" }).click();
    await expect
      .poll(
        async () =>
          (
            await localSql<{ n: number }>(
              `select count(*)::int as n from app.per_diems where engagement_id = $1 and deleted_at is null`,
              [id],
            )
          )[0]?.n,
      )
      .toBe(3);

    await page.goto(`/${ORG}/crew/per-diems?project=NWS&view=list&person=${CREW}`);
    const rows = page.getByRole("list", { name: "Per diems" }).getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("$65.00");
    await rows.first().getByRole("link").click();
    await page.getByRole("button", { name: "Remove per diem" }).click();
    const confirm = page.getByRole("dialog", { name: "Remove this per diem?" });
    await confirm.getByRole("button", { name: "Remove per diem" }).click();
    await expect
      .poll(
        async () =>
          (
            await localSql<{ n: number }>(
              `select count(*)::int as n from app.per_diems where engagement_id = $1 and deleted_at is null`,
              [id],
            )
          )[0]?.n,
      )
      .toBe(2);
  } finally {
    // The run's per diems go too, so the next run's person filter lists only its own days.
    await localSql(
      `update app.per_diems set deleted_at = now() where engagement_id = $1 and deleted_at is null`,
      [id],
    );
    await move(id, "Active", "Canceled", "Per diem journey finished.");
  }
});
