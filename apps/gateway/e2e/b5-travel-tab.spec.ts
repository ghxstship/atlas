import { toDisplayKey } from "@xos/data/gateway-keys";
import { expect, test } from "./engine-test";
import { DEMO, expectAccessible, signIn, sql, uniqueId } from "./support";

/**
 * B5 (ADR 0144): the crew Travel and Lodging tab shows the person's ground transport (driver, vehicle, pickup and
 * drop-off) from api_external.my_transfers and the project's Shared local contacts with tel: and mailto: links from
 * api_external.local_contacts. An Internal contact never shows. The fixture is an Active crew engagement for the demo
 * crew person, a transfer they ride, and two contacts; it is canceled and removed afterwards.
 */
test("B5: ground transport and Shared local contacts on Travel and Lodging", async ({ page }) => {
  const run = uniqueId();
  const [today] = await sql<{ d: string }>(`select private.project_today($1)::text as d`, [
    DEMO.project,
  ]);
  const [engagement] = await sql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis,
       arrangement, start_date, end_date)
     values ($1, $2, 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', $3::date, $3::date + 2)
     returning id`,
    [DEMO.project, DEMO.crew, today?.d],
    DEMO.owner,
  );
  const id = engagement?.id as string;
  await sql(
    `insert into app.onboarding_verifications (onboarding_item_id, org_id, outcome)
     select i.id, i.org_id, 'Passed' from app.onboarding_items i where i.engagement_id = $1 and i.deleted_at is null`,
    [id],
    DEMO.owner,
  );
  const move = (from: string, to: string) =>
    sql(
      `select private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
         'engagement_id', $1::uuid, $2, $3, 'Moved by the journey fixture.')`,
      [id, from, to],
      DEMO.owner,
    );
  await move("Onboarding", "Active");
  const [transfer] = await sql<{ id: string }>(
    `insert into app.transfers (project_id, pickup_place, pickup_at, pickup_time_zone, dropoff_place, dropoff_at,
       dropoff_time_zone)
     values ($1, $2, now() + interval '3 days', 'America/New_York', 'Crew Hotel', now() + interval '3 days 1 hour',
       'America/New_York')
     returning id`,
    [DEMO.project, `Airport Door ${run}`],
    DEMO.owner,
  );
  await sql(
    `insert into app.transfer_passengers (transfer_id, person_id, is_primary) values ($1, $2, true)`,
    [transfer?.id, DEMO.crew],
    DEMO.owner,
  );
  const [shared] = await sql<{ id: string }>(
    `insert into app.local_contacts (project_id, contact_name, contact_title, phone, email, contact_role, audience)
     values ($1, $2, 'Dispatch', '+13055550100', 'dispatch@harbor-cars.test', 'Transport', 'Shared') returning id`,
    [DEMO.project, `Harbor Cars ${run}`],
    DEMO.owner,
  );
  const [internal] = await sql<{ id: string }>(
    `insert into app.local_contacts (project_id, contact_name, contact_role) values ($1, $2, 'Production') returning id`,
    [DEMO.project, `Desk Only ${run}`],
    DEMO.owner,
  );
  try {
    await signIn(
      page,
      "crew@example.com",
      `/work/engagements/${toDisplayKey("engagement", id)}/travel-and-lodging`,
    );
    await expect(page.getByRole("heading", { name: "Ground transport" })).toBeVisible();
    await expect(page.getByText(`Airport Door ${run} to Crew Hotel`)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Local contacts" })).toBeVisible();
    await expect(page.getByText(`Harbor Cars ${run}`)).toBeVisible();
    await expect(page.getByRole("link", { name: "dispatch@harbor-cars.test" })).toHaveAttribute(
      "href",
      "mailto:dispatch@harbor-cars.test",
    );
    await expect(page.locator('a[href="tel:+13055550100"]')).toBeVisible();
    await expect(page.getByText(`Desk Only ${run}`)).toHaveCount(0);
    await expectAccessible(page);
  } finally {
    await sql(
      `update app.transfers set deleted_at = now() where id = $1`,
      [transfer?.id],
      DEMO.owner,
    );
    await sql(
      `update app.local_contacts set deleted_at = now() where id = any($1::uuid[])`,
      [[shared?.id, internal?.id]],
      DEMO.owner,
    );
    await move("Active", "Canceled");
  }
});
