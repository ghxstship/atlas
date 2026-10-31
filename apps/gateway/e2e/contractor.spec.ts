import { acceptAnswer, expectNoSidewaysScroll, sendTypedPacket } from "./advance-builder";
import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import {
  asPerson,
  contractorMilestone,
  draftContractorOpportunity,
  invoiceByNumber,
  PEOPLE,
  projectToday,
  ROLE_ACCOUNTS,
  ROLE_PEOPLE,
  roleEngagement,
  suffix,
  transition,
} from "./role-fixtures";
import { DEMO, expectAccessible, expectAccessibleInBothThemes, signIn, sql } from "./support";

/**
 * Journey 44 (Section 20.2), contractor: the scoped opportunity is remote, so the pay-transparency
 * rules that ship with the platform and cover remote roles apply (1125, A38-006), and it cannot
 * publish in Atlas without a pay range; it publishes once it has one. The contractor delivers a
 * priced milestone in Gateway, the Producer accepts it, the contractor's studio invoices against it,
 * the org pays it, and the studio appears in Atlas's 1099-NEC export for the year, whose full file
 * is a Restricted export behind step-up.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("journey 44: pay range required to publish, milestone delivered and invoiced", async ({
  page,
  browser,
}) => {
  const opportunity = await draftContractorOpportunity({ remote: true });
  const atlas = await atlasAs(browser, "producer@example.com");
  await atlas.page.goto(`/${ORG}/opportunities/postings?id=${opportunity.id}`);
  await expect(
    atlas.page.getByRole("heading", { level: 1, name: opportunity.title }),
  ).toBeVisible();
  const moveTo = atlas.page.getByRole("form", { name: "Move to" });
  await moveTo.getByLabel("Next state").selectOption("Pending Approval");
  await moveTo.getByLabel("Reason").fill("Ready for approval.");
  await moveTo.getByRole("button", { name: "Move" }).click();
  await expect(atlas.page.getByText("Pending Approval").first()).toBeVisible();
  await moveTo.getByLabel("Next state").selectOption("Published");
  await moveTo.getByLabel("Reason").fill("Approved for invited contractors.");
  await moveTo.getByRole("button", { name: "Move" }).click();
  await expect(
    atlas.page.getByText(
      "This jurisdiction requires a posted pay range. Add the lowest and highest pay, then publish.",
    ),
  ).toBeVisible();
  await expectAccessible(atlas.page);

  // With a pay range, the same posting publishes.
  await sql(
    `update app.opportunities set pay_min_minor = 600000, pay_max_minor = 800000 where id = $1`,
    [opportunity.id],
    PEOPLE.owner,
  );
  await atlas.page.reload();
  await moveTo.getByLabel("Next state").selectOption("Published");
  await moveTo.getByLabel("Reason").fill("Approved with the posted range.");
  await moveTo.getByRole("button", { name: "Move" }).click();
  await expect
    .poll(
      async () =>
        (
          await sql<{ s: string }>(
            `select opportunity_state::text as s from app.opportunities where id = $1`,
            [opportunity.id],
          )
        )[0]?.s,
    )
    .toBe("Published");

  // The contractor's engagement: deliver milestone 1 in Gateway.
  const engagement = await roleEngagement({
    person: ROLE_PEOPLE.contractor,
    account: ROLE_ACCOUNTS.studio,
    roleType: "Contractor",
    roleCode: "9000.50.03",
    rateMinor: 120000,
  });
  await transition("engagement", engagement.id, "Onboarding", "Active", "Contract signed.");
  const milestone = `Milestone 1 lighting plot ${suffix()}`;
  const deliverable = await contractorMilestone(engagement.id, milestone);
  await asPerson(PEOPLE.producer, `select app.set_deliverable_fee($1, 350000)`, [deliverable.id]);

  await signIn(page, "contractor@example.com", `/work/engagements/${engagement.key}/deliverables`);
  const form = page.getByRole("form", { name: milestone });
  await expect(form).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await form.getByLabel("Document").selectOption({ label: deliverable.file });
  await form.getByLabel("Message").fill("Plot and cue list for the main stage.");
  await form.getByRole("button", { name: "Submit deliverable" }).click();
  await expect(page.getByText("Submitted. The organization accepts or returns it.")).toBeVisible();

  await asPerson(
    PEOPLE.producer,
    `select app.decide_deliverable($1, 'Approved', 'Plot accepted as delivered.')`,
    [deliverable.id],
  );
  await page.reload();
  await expect(page.getByRole("listitem").filter({ hasText: milestone })).toContainText("Accepted");

  // Invoice against the accepted milestone, as the contractor's studio.
  await page
    .context()
    .addCookies([{ name: "xos-acting", value: ROLE_ACCOUNTS.studio, url: page.url() }]);
  const number = `DDS-${suffix()}`;
  await page.goto(`/work/engagements/${engagement.key}/invoices`);
  const invoice = page.getByRole("form", { name: "Invoice" });
  await invoice.getByLabel("Invoice number").fill(number);
  await invoice.getByLabel("Item or service").fill(milestone);
  await invoice.getByLabel("Unit price").fill("3500.00");
  await invoice.getByRole("button", { name: "Submit invoice" }).click();
  await expect(
    page.getByText("Invoice submitted. Follow it on the payment tracker."),
  ).toBeVisible();
  const submitted = await invoiceByNumber(number);
  expect(submitted.id).toBeTruthy();
  const [line] = await sql<{ description: string; unit_price_minor: string }>(
    `select description, unit_price_minor::text from app.invoice_lines where invoice_id = $1`,
    [submitted.id],
  );
  expect(line).toEqual({ description: milestone, unit_price_minor: "350000" });
  await expectAccessible(page);
  await atlas.context.close();

  // Paid this year: approved by the Producer, recorded by finance, approved by the Owner.
  await asPerson(PEOPLE.producer, `select app.approve_invoice($1, 'Milestone accepted.')`, [
    submitted.id,
  ]);
  // Paid today on the project's calendar (the org's year-end counts that date), not the database's
  // UTC date, which is already tomorrow, or next year, on an evening in New York.
  const today = await projectToday();
  const [payment] = await asPerson<{ id: string }>(
    PEOPLE.admin,
    `select app.record_invoice_payment($1, $2::date, null, $3) as id`,
    [submitted.id, today, `ACH-${number}`],
  );
  await asPerson(PEOPLE.owner, `select app.approve_payment($1, 'Remittance confirmed.')`, [
    payment?.id,
  ]);

  // The studio's W-9 with its address, given in Gateway's tax documents.
  const tin = `98${String(Date.now()).slice(-7)}`;
  await asPerson(ROLE_PEOPLE.contractor, `select app.submit_tax_form($1, 'W-9', $2, $3)`, [
    DEMO.org,
    tin,
    ROLE_ACCOUNTS.studio,
  ]);
  await page.goto("/money/tax-documents");
  const w9 = page.getByRole("form", { name: "W-9 name and mailing address" }).first();
  await w9.getByLabel("Street address").fill("200 Biscayne Blvd");
  await w9.getByLabel("City").fill("Miami");
  await w9.getByLabel("State").fill("FL");
  await w9.getByLabel("ZIP code").fill("33131");
  await w9.getByRole("button", { name: "Save address" }).click();
  // The US postal format, street on one line and city, state and ZIP on the next (d4de1e9f).
  await expect(page.getByText("200 Biscayne Blvd Miami, FL 33131").first()).toBeVisible();
  await expectAccessible(page);

  // Atlas, Finance, Year-end: the studio is a 1099-NEC payee; the file needs step-up.
  const year = Number(today.slice(0, 4));
  const owner = await atlasAs(browser, "owner@example.com");
  await owner.page.goto(`/${ORG}/finance/year-end?year=${year}`);
  const studio = owner.page.getByRole("row").filter({ hasText: tin.slice(-4) });
  await expect(studio).toContainText("W-9 on file");
  await owner.page.getByRole("button", { name: "Download 1099-NEC file" }).click();
  await expect(owner.page.getByText(/step-up authentication/).first()).toBeVisible();
  await expectAccessible(owner.page);
  await owner.context.close();
});

/**
 * R9 (RRR-189, ADR 0100 section 8): a contractor gets the Advance tab. The org sends a packet with a
 * site access window and a credential request; the contractor proposes the window and asks for a
 * site pass for the whole team, Atlas accepts both, and the pass reads Approved in Gateway. Nothing
 * of the packet or the answers is written with SQL.
 */
test("contractor advance: site access window and credential request", async ({ page, browser }) => {
  const tag = suffix();
  const engagement = await roleEngagement({
    person: ROLE_PEOPLE.contractor,
    account: ROLE_ACCOUNTS.studio,
    roleType: "Contractor",
    roleCode: "9000.50.03",
  });
  const passName = `Site Pass ${tag}`;
  const [category] = await sql<{ id: string }>(
    "insert into app.credential_categories (project_id, code, name) values ($1, $2, $3) returning id",
    [DEMO.project, `SP${tag}`, passName],
    PEOPLE.owner,
  );
  const access = `Site access ${tag}`;
  const passes = `Site passes ${tag}`;
  let atlas: { close: () => Promise<void> } | null = null;
  try {
    const sent = await sendTypedPacket(browser, {
      project: "NWS · Northwind Summer Series",
      title: `Contractor Advance ${tag}`,
      sections: [
        { title: access, kind: "Schedule window", windowKind: "Arrival" },
        { title: passes, kind: "Credential request", choices: [passName] },
      ],
      party: `person:${ROLE_PEOPLE.contractor}`,
      engagementId: engagement.id,
    });
    atlas = sent.context;

    await signIn(page, "contractor@example.com", `/work/engagements/${engagement.key}/advance`);
    await expect(
      page.getByRole("navigation", { name: "Engagement sections" }).getByRole("link", {
        name: "Advance",
      }),
    ).toBeVisible();
    const sentOk = page
      .getByRole("status")
      .filter({ hasText: "Sent. The organization reviews your answer." });
    const window = page
      .getByRole("form", { name: access })
      .getByRole("group", { name: "Window 1" });
    await window.getByLabel("Starts", { exact: true }).fill("2027-06-04T07:00");
    await window.getByLabel("Ends", { exact: true }).fill("2027-06-04T08:30");
    await page
      .getByRole("form", { name: access })
      .getByRole("button", { name: "Send answer" })
      .click();
    await expect(sentOk).toBeVisible();
    await page.reload();
    const pass = page.getByRole("form", { name: passes });
    await pass
      .getByRole("group", { name: "Line 1" })
      .getByLabel("Pass", { exact: true })
      .selectOption({ label: passName });
    await pass.getByRole("button", { name: "Send answer" }).click();
    await expect(sentOk).toBeVisible();
    await page.reload();
    const answered = page.getByRole("listitem").filter({ hasText: access });
    await expect(answered.getByText("Awaiting review")).toBeVisible();
    await expect(page.getByText(`1 × ${passName}`)).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await expectNoSidewaysScroll(page);
    await page.setViewportSize({ width: 1280, height: 900 });

    // Atlas accepts both; the pass is approved for the contractor's engagement.
    await sent.page.goto(sent.url);
    await acceptAnswer(sent.page, access, "Demo Contractor");
    await acceptAnswer(sent.page, passes, "Demo Contractor");
    await expect
      .poll(async () => {
        const [row] = await sql<{ state: string }>(
          `select allocation_state::text as state from app.advance_allocations
            where engagement_id = $1 and credential_category_id = $2 and deleted_at is null`,
          [engagement.id, category?.id],
        );
        return row?.state;
      })
      .toBe("Approved");
    await page.reload();
    await expect(
      page.getByRole("list", { name: "What you asked for" }).getByText("Approved", { exact: true }),
    ).toBeVisible();
  } finally {
    await atlas?.close();
    await sql(
      `update app.advance_allocations set deleted_at = now() where engagement_id = $1 and deleted_at is null`,
      [engagement.id],
    ).catch(() => undefined);
    await sql(
      `update app.advance_packets set deleted_at = now()
        where id in (select advance_packet_id from app.advance_recipients where engagement_id = $1) and deleted_at is null`,
      [engagement.id],
    ).catch(() => undefined);
  }
});
