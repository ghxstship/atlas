import { toDisplayKey } from "@xos/data/gateway-keys";
import { expect, test } from "./engine-test";
import { asPerson, offerToApplication, PEOPLE, PROJECT, suffix, transition } from "./role-fixtures";
import { DEMO, expectAccessible, signIn, sql } from "./support";

/**
 * P10 (RRR-224, gap G-128): a crew posting whose client and event stay hidden until booking. The invited crew member
 * finds it on Explore and opens it: the city, the Client confidential tag and the booked notice show, and the venue
 * name does not. Once the org's offer is accepted, the detail page shows the venue. The org side is written as the
 * demo Owner through the lifecycle engine and the offer RPCs Atlas calls.
 */
test("an invited crew member sees a confidential listing, and the venue once booked", async ({
  page,
}) => {
  test.setTimeout(4 * 60_000);
  const [venue] = await sql<{ id: string; name: string; locality: string }>(
    `select v.id, v.name, v.locality from app.venues v
      where v.org_id = $1 and v.deleted_at is null and nullif(btrim(v.locality), '') is not null
      order by (v.id = (select p.venue_id from app.projects p where p.id = $2)) desc, v.name
      limit 1`,
    [DEMO.org, PROJECT],
  );
  expect(venue, "the demo org has a venue with a locality").toBeTruthy();
  const title = `Confidential Deck Crew ${suffix()}`;
  const [opp] = await sql<{ id: string }>(
    `insert into app.opportunities (project_id, requisition_id, role_type, role_code, title, description, visibility,
       rate_type, pay_min_minor, pay_max_minor, currency_code, starts_on, ends_on, deadline_at, venue_id,
       hide_client_until_booked)
     values ($1, '01920000-0000-7000-8000-000000228001', 'Crew', '5000.51.02', $2, 'Deck crew for the changeovers.',
       'Invited', 'Day', 85000, 95000, 'USD', '2027-06-04', '2027-06-06', now() + interval '30 days', $3, true)
     returning id`,
    [PROJECT, title, venue?.id],
    PEOPLE.owner,
  );
  const id = opp?.id as string;
  const key = toDisplayKey("opportunity", id);
  await sql(
    `insert into app.opportunity_invitations (opportunity_id, person_id) values ($1, $2)`,
    [id, DEMO.crew],
    PEOPLE.owner,
  );
  await transition("opportunity", id, "Draft", "Pending Approval", "Ready for approval.");
  await transition("opportunity", id, "Pending Approval", "Published", "Approved for the crew.");

  await signIn(page, "crew@example.com");
  await page.goto(`/explore?q=${encodeURIComponent(title)}`);
  const card = page.getByRole("article").filter({ hasText: title });
  await expect(card.getByText("Client confidential")).toBeVisible();
  await expect(card.getByText(venue?.locality ?? "")).toBeVisible();
  await expect(card.getByText(venue?.name ?? "", { exact: true })).toHaveCount(0);
  await expectAccessible(page);

  await page.goto(`/explore/${key}`);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByText("The client and event are shared once you're booked.")).toBeVisible();
  await expect(page.getByText("Client confidential").first()).toBeVisible();
  await expect(page.getByText(venue?.locality ?? "").first()).toBeVisible();
  await expect(page.getByText(venue?.name ?? "", { exact: true })).toHaveCount(0);
  await expectAccessible(page);

  // The crew member applies; the org sends its offer and the crew member accepts it: they are booked.
  await asPerson(
    DEMO.crew,
    `insert into app.applications (opportunity_id, applicant_person_id, availability_confirmed) values ($1, $2, true)`,
    [id, DEMO.crew],
  );
  const { applicationId } = await offerToApplication(id);
  const [offer] = await sql<{ id: string }>(
    `select id from app.offers where application_id = $1 and deleted_at is null`,
    [applicationId],
  );
  await asPerson(DEMO.crew, `select app.accept_offer($1)`, [offer?.id]);

  await page.goto(`/explore/${key}`);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByText(venue?.name ?? "").first()).toBeVisible();
  await expect(page.getByText("The client and event are shared once you're booked.")).toHaveCount(
    0,
  );
  await expect(page.getByText("Client confidential")).toHaveCount(0);
});
