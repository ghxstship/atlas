import { expect as baseExpect, test } from "./engine-test";
import { toDisplayKey } from "@xos/data/gateway-keys";
import {
  asPerson,
  newSignIn,
  offer,
  PEOPLE,
  PROJECT,
  ROLE_PEOPLE,
  roleEngagement,
  suffix,
  transition,
} from "./role-fixtures";
import { expectAccessible, signIn, sql } from "./support";

/**
 * B6 (RRR-230, G-65): Travel and Lodging and the artist's Hospitality tab show the whole stay by day, and a row an
 * Atlas writer changed after the person last looked carries a tag naming what changed. A crew person new to the org
 * looks once and marks it all as seen; the demo Owner, signed in as an Atlas writer would be, moves their flight
 * under row level security; on reload the flight reads "Changed since you last looked: Departure" and the check-in
 * sits on its own date. The artist's Hospitality tab places their set time inside the itinerary.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("B6: a crew traveller's itinerary marks the flight an Atlas writer moved", async ({
  page,
}) => {
  const tag = suffix().toLowerCase();
  const email = `itinerary-${tag}@example.com`;
  const person = await newSignIn(email, `Demo Traveller ${tag.toUpperCase()}`);
  await offer("offerings.travel");
  const [engagement] = await sql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis,
       arrangement, agreed_rate_minor, currency_code, start_date, end_date)
     values ($1, $2, 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 90000, 'USD',
       '2027-06-04', '2027-06-06')
     returning id`,
    [PROJECT, person],
    PEOPLE.owner,
  );
  const engagementId = engagement?.id as string;
  await transition("engagement", engagementId, "Onboarding", "Active", "Crew confirmed.");
  const [flight] = await asPerson<{ id: string }>(
    PEOPLE.owner,
    `insert into app.travel_segments (project_id, person_id, engagement_id, travel_mode, operator_name, service_identifier,
       departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_at, arrives_time_zone)
     values ($1, $2, $3, 'Flight', 'Coastal Air', 'CA 412', 'LAX', '2027-06-03T16:00:00Z', 'America/Los_Angeles', 'MIA',
       '2027-06-04T00:05:00Z', 'America/New_York')
     returning id`,
    [PROJECT, person, engagementId],
  );
  const [block] = await asPerson<{ id: string }>(
    PEOPLE.owner,
    `insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held)
     values ($1, $2, '2027-06-03', '2027-06-08', 4) returning id`,
    [PROJECT, `Crew Hotel ${tag.toUpperCase()}`],
  );
  await asPerson(
    PEOPLE.owner,
    `insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on)
     values ($1, $2, '2027-06-03', '2027-06-06')`,
    [block?.id, person],
  );

  const key = toDisplayKey("engagement", engagementId);
  await signIn(page, email, `/work/engagements/${key}/travel-and-lodging`);
  await expect(page.getByRole("heading", { name: "Your stay" })).toBeVisible();
  await expect(
    page.getByText("From your next visit, changes to your stay are marked here."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Mark all as seen" }).click();
  // Once the marker is saved the page refreshes with a baseline, and the first-visit note goes.
  await expect(
    page.getByText("From your next visit, changes to your stay are marked here."),
  ).toBeHidden();

  await asPerson(
    PEOPLE.owner,
    `update app.travel_segments set departs_at = departs_at + interval '1 hour', arrives_at = arrives_at + interval '1 hour'
     where id = $1`,
    [flight?.id],
  );
  await page.reload();
  const flightRow = page.getByRole("listitem").filter({ hasText: "LAX to MIA" });
  await expect(flightRow.getByText("Changed since you last looked: Departure")).toBeVisible();
  const checkInDay = page.getByRole("list", { name: "Jun 3, 2027" });
  await expect(checkInDay.getByRole("listitem").filter({ hasText: "Check-in" })).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Jun 6, 2027" }).getByText("Check-out"),
  ).toBeVisible();
  await expectAccessible(page);

  // Back as the demo found it: the trip and the room leave the project.
  await asPerson(PEOPLE.owner, `update app.travel_segments set deleted_at = now() where id = $1`, [
    flight?.id,
  ]);
  await asPerson(
    PEOPLE.owner,
    `update app.accommodation_assignments set deleted_at = now() where accommodation_block_id = $1`,
    [block?.id],
  );
});

test("B6: the artist's Hospitality tab shows their set time inside the itinerary", async ({
  page,
}) => {
  await offer("offerings.travel");
  const engagement = await roleEngagement({ person: ROLE_PEOPLE.artist, roleType: "Artist" });
  await transition("engagement", engagement.id, "Onboarding", "Active", "Artist confirmed.");
  const label = `Headline Set ${engagement.key.slice(-4)}`;
  const [ros] = await asPerson<{ id: string }>(
    PEOPLE.owner,
    `insert into app.run_of_show (project_id, name, show_date) values ($1, 'Main Stage', '2027-06-05') returning id`,
    [PROJECT],
  );
  const [cue] = await asPerson<{ id: string }>(
    PEOPLE.owner,
    `insert into app.cues (run_of_show_id, position, label, planned_at, duration)
     values ($1, 1, $2, '2027-06-06T01:00:00Z', interval '75 minutes') returning id`,
    [ros?.id, label],
  );
  await asPerson(
    PEOPLE.owner,
    `insert into app.engagement_cues (engagement_id, cue_id) values ($1, $2)`,
    [engagement.id, cue?.id],
  );
  await signIn(page, "artist@example.com", `/work/engagements/${engagement.key}/hospitality`);
  await expect(page.getByRole("heading", { name: "Your stay" })).toBeVisible();
  // 01:00 UTC on June 6 is 21:00 on June 5 in the project's zone, so the set sits on June 5.
  const setDay = page.getByRole("list", { name: "Jun 5, 2027" });
  await expect(setDay.getByRole("listitem").filter({ hasText: label })).toBeVisible();
  await expect(setDay.getByText("Set", { exact: false }).first()).toBeVisible();
  await expectAccessible(page);
  await asPerson(PEOPLE.owner, `update app.run_of_show set deleted_at = now() where id = $1`, [
    ros?.id,
  ]);
});
