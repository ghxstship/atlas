import { expect as baseExpect, test } from "./engine-test";
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
import { DEMO, expectAccessible, signIn, sql } from "./support";

/**
 * Journey 41 (Section 20.2), the crew lifecycle chained end to end with a person new to the org:
 * the crew call from the approved requisition; the application in Gateway; the offer accepted;
 * onboarding with the engagement Blocked until the background check passes (verified in Atlas);
 * the shift accepted in Gateway and worked (the Compass clock in and out's server half, as the
 * person); the timesheet submitted in Gateway and approved; both sides rated; and the credential
 * gone from the person's Gateway at close. Pay for the individual freelancer runs through
 * self-billing, Atlas finance recording the payment, and Gateway's Money tracker (A43, A38-007).
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

    // Paid (A43, finding A38-007): the person, engaged as an individual with no company account,
    // agrees to self-billing on the engagement's Invoices tab; the org bills the approved timesheet
    // to the person, approves the invoice, Atlas finance records the payment and another approver
    // approves it; Gateway's Money tracker follows it from Submitted to Paid.
    await page.goto(`/work/engagements/${key}/invoices`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Agree to self-billing" }).click();
    await expect(page.getByText("Self-billing on")).toBeVisible();
    await sql(
      `select app.set_setting($1, 'finance.self_billing_enabled', 'Organization', $1, null, true, null, false)`,
      [DEMO.org],
      PEOPLE.owner,
    );
    const [billed] = await asPerson<{ id: string }>(
      PEOPLE.producer,
      `select app.generate_self_billed_invoice($1, '2027-06-01', '2027-06-30') as id`,
      [id],
    );
    const invoiceId = billed?.id as string;
    const [invoice] = await sql<{ n: string; payee: string | null }>(
      `select invoice_number as n, payee_person_id::text as payee from app.invoices where id = $1`,
      [invoiceId],
    );
    expect(invoice?.payee).toBe(person);
    const tracker = (number: string) =>
      page.getByRole("region", { name: `Payment tracker for invoice ${number}` });
    const current = (number: string) => tracker(number).locator('[aria-current="step"]');
    await page.goto("/money/invoices?view=list");
    await expect(current(invoice?.n ?? "")).toContainText("Submitted");
    await asPerson(
      PEOPLE.admin,
      `select app.approve_invoice($1, 'Matches the approved timesheet.')`,
      [invoiceId],
    );
    const finance = await atlasAs(browser, "admin@example.com");
    await finance.page.goto(`/${ORG}/finance/invoices?peek=${invoiceId}&pay=1`);
    const pay = finance.page.getByRole("dialog");
    await pay.getByLabel("Bank or card reference").fill(`ACH-${tag.toUpperCase()}`);
    await pay.getByRole("button", { name: "Record payment" }).click();
    await expect
      .poll(
        async () =>
          (
            await sql<{ n: string }>(
              `select count(*)::text as n from app.payment_applications where invoice_id = $1 and deleted_at is null`,
              [invoiceId],
            )
          )[0]?.n,
      )
      .toBe("1");
    await expectAccessible(finance.page);
    await finance.context.close();
    await page.goto("/money/invoices?view=list");
    await expect(current(invoice?.n ?? "")).toContainText("Scheduled");
    const [payment] = await sql<{ id: string }>(
      `select payment_id::text as id from app.payment_applications where invoice_id = $1 and deleted_at is null`,
      [invoiceId],
    );
    await asPerson(PEOPLE.owner, `select app.approve_payment($1, 'Remittance confirmed.')`, [
      payment?.id,
    ]);
    await page.goto("/money/invoices?view=list");
    await expect(current(invoice?.n ?? "")).toContainText("Paid");
    await page.goto("/money/payments");
    await expect(page.getByText(`ACH-${tag.toUpperCase()}`).first()).toBeVisible();
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
