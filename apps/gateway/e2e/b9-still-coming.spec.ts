import { expect as baseExpect, test } from "./engine-test";
import { suffix } from "./role-fixtures";
import { DEMO, expectAccessible, signIn, sql } from "./support";

/**
 * B9 (ADR 0148, S11.10-06): Gateway Home shows "Still coming?" in Needs You, not in For Your Information. The crew member
 * answers I'm coming in place, the ask leaves the list and the answer lands; a second ask, answered Can't make it with a
 * reason, returns the shift to open shifts. Each ask starts tomorrow, so it cannot already have started.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(120_000);
const expect = baseExpect.configure({ timeout: 20_000 });

/** An Accepted engaged shift starting tomorrow, with a Waiting ask and its notification, as the hourly job leaves them. */
async function askAboutShift(title: string): Promise<string> {
  const [shift] = await sql<{ id: string }>(
    `insert into app.shifts (org_id, project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
     values ($1, $2, $3, '0000.50.01', now() + interval '1 day', now() + interval '1 day 8 hours', 'America/New_York')
     returning id`,
    [DEMO.org, DEMO.project, DEMO.crewEngagement],
  );
  const id = shift?.id as string;
  await sql(
    `select private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions', 'shift_id', $1::uuid, 'Draft', 'Published', 'Published for the journey.')`,
    [id],
  );
  await sql(
    `select app.accept_engaged_shift($1::uuid, 'Accepted for the journey.')`,
    [id],
    DEMO.crew,
  );
  await sql(
    `insert into app.shift_responses (project_id, shift_id, person_id, ask_kind) values ($1, $2, $3, 'Reconfirmation')`,
    [DEMO.project, id, DEMO.crew],
  );
  await sql(
    `select private.notify($1, $2, 'shift.reconfirm', 'app.shifts', $3::uuid, $4,
       jsonb_build_object('title', $5::text, 'startsAt', to_char(now() + interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))`,
    [DEMO.org, DEMO.crew, id, DEMO.project, title],
  );
  return id;
}

test("B9: Still coming? is answered from Needs You", async ({ page }) => {
  const tag = suffix();
  const coming = await askAboutShift(`Still Coming ${tag} A`);
  const declined = await askAboutShift(`Still Coming ${tag} B`);

  await signIn(page, "crew@example.com", "/home");
  // Either ask finds the list, so it still resolves once the first has left.
  const needs = page.getByRole("list").filter({ hasText: `Still coming to Still Coming ${tag} ` });
  await expect(needs).toBeVisible();
  // It waits on an answer, so For Your Information leaves it out.
  await expect(page.getByRole("list", { name: "For your information" })).not.toContainText(
    `Still Coming ${tag} A`,
  );
  await expectAccessible(page);

  const first = needs.getByRole("listitem").filter({ hasText: `Still Coming ${tag} A` });
  await expect(async () => {
    await first.getByRole("button", { name: "I'm coming" }).click();
    await expect(page.getByText(`Still coming to Still Coming ${tag} A?`)).toBeHidden({
      timeout: 2_000,
    });
  }).toPass();
  await expect(page.getByRole("status").getByText("You're confirmed.")).toBeVisible();
  const [yes] = await sql<{ answer: string }>(
    `select answer::text from app.shift_responses where shift_id = $1 and ask_kind = 'Reconfirmation'`,
    [coming],
  );
  expect(yes?.answer).toBe("Accepted");

  const second = needs.getByRole("listitem").filter({ hasText: `Still Coming ${tag} B` });
  const why = second.getByLabel("Reason (optional)");
  await expect(async () => {
    // Opens the form; once it is open the same words are its submit, so it is pressed only while the form is shut.
    if (!(await why.isVisible()))
      await second.getByRole("button", { name: "Can't make it" }).click();
    await expect(why).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await why.fill("Family matter.");
  await second.getByRole("button", { name: "Can't make it" }).click();
  await expect(page.getByText(`Still coming to Still Coming ${tag} B?`)).toBeHidden();
  await expect(page.getByRole("status").getByText("Thanks for letting us know.")).toBeVisible();
  const [no] = await sql<{ answer: string; shift_state: string; engagement_id: string | null }>(
    `select r.answer::text, s.shift_state::text, s.engagement_id from app.shift_responses r
     join app.shifts s on s.id = r.shift_id where r.shift_id = $1 and r.ask_kind = 'Reconfirmation'`,
    [declined],
  );
  expect(no).toEqual({ answer: "Declined", shift_state: "Published", engagement_id: null });
});
