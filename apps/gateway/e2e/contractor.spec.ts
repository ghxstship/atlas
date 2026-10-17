import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import {
  asPerson,
  contractorMilestone,
  draftContractorOpportunity,
  invoiceByNumber,
  PEOPLE,
  ROLE_ACCOUNTS,
  ROLE_PEOPLE,
  roleEngagement,
  suffix,
  temporaryPayTransparencyRule,
  transition,
} from "./role-fixtures";
import { expectAccessible, expectAccessibleInBothThemes, signIn, sql } from "./support";

/**
 * Journey 44 (Section 20.2), contractor: in a pay-transparency jurisdiction the scoped
 * opportunity cannot publish in Atlas without a pay range, and publishes once it has one; the
 * contractor delivers a milestone in Gateway, the Producer accepts it, and the contractor
 * invoices against it. The 1099-NEC export does not exist yet (finding A38-006), and no
 * pay-transparency rule ships with the platform, so a local test rule stands in (A38-006).
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("journey 44: pay range required to publish, milestone delivered and invoiced", async ({
  page,
  browser,
}) => {
  const rule = await temporaryPayTransparencyRule();
  try {
    const opportunity = await draftContractorOpportunity();
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

    await signIn(
      page,
      "contractor@example.com",
      `/work/engagements/${engagement.key}/deliverables`,
    );
    const form = page.getByRole("form", { name: milestone });
    await expect(form).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await form.getByLabel("Document").selectOption({ label: deliverable.file });
    await form.getByLabel("Message").fill("Plot and cue list for the main stage.");
    await form.getByRole("button", { name: "Submit deliverable" }).click();
    await expect(
      page.getByText("Submitted. The organization accepts or returns it."),
    ).toBeVisible();

    await asPerson(
      PEOPLE.producer,
      `select app.decide_deliverable($1, 'Approved', 'Plot accepted as delivered.')`,
      [deliverable.id],
    );
    await page.reload();
    await expect(page.getByRole("listitem").filter({ hasText: milestone })).toContainText(
      "Accepted",
    );

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
  } finally {
    await rule.remove();
  }
});
