import { expect as baseExpect, test } from "@playwright/test";
import { toDisplayKey } from "@xos/data/gateway-keys";
import { atlasAs, ORG } from "./atlas";
import {
  asPerson,
  engagementCredential,
  newSignIn,
  offerToApplication,
  PEOPLE,
  publishCrewCall,
  publishedShift,
  requirements,
  suffix,
  transition,
  workedShift,
} from "./role-fixtures";
import { expectAccessible, signIn, sql } from "./support";

/**
 * Journey 41 (Section 20.2), the crew lifecycle chained end to end with a person new to the org:
 * the crew call from the approved requisition; the application in Gateway; the offer accepted;
 * onboarding with the engagement Blocked until the background check passes (verified in Atlas);
 * the shift accepted in Gateway and worked (the Compass clock in and out's server half, as the
 * person); the timesheet submitted in Gateway and approved; both sides rated; and the credential
 * gone from the person's Gateway at close. Pay for an individual freelancer has no path yet
 * (finding A38-007).
 * opportunities.spec.ts and crew.spec.ts cover the individual steps' screens in more depth.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("journey 41: requisition to credential loss, one crew person through every stage", async ({
  page,
  browser,
}) => {
  const tag = suffix().toLowerCase();
  const email = `crew-${tag}@example.com`;
  const person = await newSignIn(email, `Demo Deckhand ${tag.toUpperCase()}`);
  const check = await requirements("Crew", [
    { name: `Background check ${tag}`, kind: "Background Check" },
  ]);
  try {
    const call = await publishCrewCall(person);

    // Apply in Gateway.
    await signIn(page, email, `/explore/${call.key}`);
    const form = page.getByRole("form", { name: `Apply for ${call.title}` });
    await form.getByLabel("I am available for these dates").check();
    await form.getByRole("button", { name: "Send application" }).click();
    await expect(page.getByText(/You applied on|Application sent/).first()).toBeVisible();

    // Shortlisted and offered by the org; accepted in Gateway.
    const { applicationId } = await offerToApplication(call.id, {
      rateType: "Day",
      amountMinor: 90000,
      starts: "2027-06-04",
      ends: "2027-06-06",
      message: "Deck crew, three days.",
    });
    await page.goto("/work/applications?view=list");
    await page.waitForLoadState("networkidle");
    await page
      .getByRole("listitem")
      .filter({ hasText: call.title })
      .getByRole("button", { name: "Accept offer" })
      .click();
    await expect
      .poll(
        async () =>
          (
            await sql<{ s: string }>(
              `select application_state::text as s from app.applications where id = $1`,
              [applicationId],
            )
          )[0]?.s,
      )
      .toBe("Accepted");
    const [created] = await asPerson<{ id: string }>(
      PEOPLE.producer,
      `select app.create_engagement_from_application($1, 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', null, null) as id`,
      [applicationId],
    );
    const id = created?.id as string;
    const key = toDisplayKey("engagement", id);

    // Blocked until the background check passes; the Producer records the results in Atlas.
    await transition("engagement", id, "Onboarding", "Blocked", "Waiting on the background check.");
    await expect(transition("engagement", id, "Blocked", "Active", "Too early.")).rejects.toThrow(
      /onboarding_incomplete|blocking onboarding item/,
    );
    const atlas = await atlasAs(browser, "producer@example.com");
    await atlas.page.goto(`/${ORG}/opportunities/engagements?id=${id}`);
    const record = atlas.page.getByRole("button", { name: "Record verification" });
    await expect(record.first()).toBeVisible();
    for (let open = await record.count(); open > 0; open = await record.count()) {
      await record.first().click();
      await expect(record).toHaveCount(open - 1);
    }
    await expectAccessible(atlas.page);
    await atlas.context.close();
    await transition("engagement", id, "Blocked", "Active", "Background check passed.");

    // Shift accepted in Gateway and worked; credential issued for the show.
    const shift = await publishedShift(id);
    const credential = await engagementCredential(id, person);
    await page.goto(`/work/engagements/${key}/shifts`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Accept shift" }).click();
    await expect
      .poll(
        async () =>
          (
            await sql<{ s: string }>(
              `select shift_state::text as s from app.shifts where id = $1`,
              [shift.id],
            )
          )[0]?.s,
      )
      .toBe("Accepted");
    await page.goto(`/work/engagements/${key}/credentials`);
    await expect(page.getByRole("listitem").filter({ hasText: credential.number })).toContainText(
      "Valid",
    );
    const { timesheetId } = await workedShift(id, shift.id, person);

    // Timesheet submitted in Gateway, approved by the Producer.
    await page.goto(`/work/engagements/${key}/timesheets?view=list`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await sql<{ s: string }>(
              `select timesheet_state::text as s from app.timesheets where id = $1`,
              [timesheetId],
            )
          )[0]?.s,
      )
      .toBe("Submitted");
    await asPerson(
      PEOPLE.producer,
      `select app.decide_timesheet($1, 'Approved', 'Hours match the shift.')`,
      [timesheetId],
    );

    // Paid: an individual freelancer cannot be paid yet. Self-billed invoices and payments both
    // name an external account, a person engaged without a company has none and the engagement's
    // party never changes, and crew have no Invoices tab (finding A38-007). The approved time is
    // what pay would come from.
    const [approved] = await sql<{ s: string }>(
      `select timesheet_state::text as s from app.timesheets where id = $1`,
      [timesheetId],
    );
    expect(approved?.s).toBe("Approved");
    await page.goto(`/work/engagements/${key}/timesheets?view=list`);
    await expect(page.getByText("Approved").first()).toBeVisible();
    await expectAccessible(page);

    // Close: rated by both, and the credential leaves the person's Gateway.
    await transition("engagement", id, "Active", "Closing", "Show complete.");
    await transition("engagement", id, "Closing", "Complete", "Paid and closed.");
    await sql(
      `insert into app.ratings (engagement_id, rater_side, score, comment) values ($1, 'Organization', 5, 'Fast changeovers.')`,
      [id],
      PEOPLE.owner,
    );
    await sql(
      `insert into app.ratings (engagement_id, rater_side, score, comment) values ($1, 'Party', 5, 'Clear calls.')`,
      [id],
      person,
    );
    const [rated] = await sql<{ n: string }>(
      `select count(*)::text as n from app.ratings where engagement_id = $1`,
      [id],
    );
    expect(rated?.n).toBe("2");
    const after = await page.goto(`/work/engagements/${key}/credentials`);
    if (after?.status() === 200) {
      await expect(page.getByText(credential.number)).toHaveCount(0);
    } else {
      expect(after?.status()).toBe(404);
    }
    const visible = await asPerson<{ n: string }>(
      person,
      `select count(*)::text as n from api_external.credentials where credential_number = $1`,
      [credential.number],
    );
    expect(visible[0]?.n).toBe("0");
  } finally {
    await check.retire();
  }
});
