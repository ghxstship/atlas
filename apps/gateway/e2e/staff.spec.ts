import { expect as baseExpect, test } from "@playwright/test";
import { atlasAs, ORG } from "./atlas";
import {
  asPerson,
  engagementShift,
  offerToApplication,
  PEOPLE,
  publishStaffOpportunity,
  requirements,
  ROLE_ACCOUNTS,
  ROLE_PEOPLE,
  roleEngagement,
  suffix,
  transition,
} from "./role-fixtures";
import { expectAccessible, expectAccessibleInBothThemes, signIn, sql } from "./support";

/**
 * Journey 42 (Section 20.2), staffing agency: the agency submits a slate of named staff in
 * Gateway, wins the award by accepting the org's offer, and its staff are assigned; each staff
 * member acknowledges the safety briefing in Gateway, and only once the Producer has verified it
 * in Atlas does the engagement go Active and the assigned position show. A staff member who has
 * not acknowledged cannot be activated.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("journey 42: slate, award, training acknowledgments, then positions", async ({
  page,
  browser,
}) => {
  const briefing = `Gate safety briefing ${suffix()}`;
  const rules = await requirements("Staff", [{ name: briefing, kind: "Acknowledgment" }]);
  try {
    const opportunity = await publishStaffOpportunity();

    // The agency, acting as its company, puts two named staff forward.
    await signIn(page, "agency@example.com", "/home");
    await page
      .context()
      .addCookies([{ name: "xos-acting", value: ROLE_ACCOUNTS.agency, url: page.url() }]);
    await page.goto(`/explore/${opportunity.key}`);
    const form = page.getByRole("form", { name: `Apply for ${opportunity.title}` });
    await expect(form.getByText("Your slate")).toBeVisible();
    await expectAccessible(page);
    await form.getByLabel("I am available for these dates").check();
    await form.getByRole("button", { name: "Send application" }).click();
    await expect(form.getByText("Pick at least one team member for the slate.")).toBeVisible();
    await form.getByLabel("Demo Staff One").check();
    await form.getByLabel("Demo Staff Two").check();
    await form.getByRole("button", { name: "Send application" }).click();
    await expect(page.getByText(/You applied on|Application sent/).first()).toBeVisible();
    const slate = await sql<{ person_id: string }>(
      `select s.person_id from app.agency_slates s join app.applications a on a.id = s.application_id
        where a.opportunity_id = $1 and s.deleted_at is null order by s.person_id`,
      [opportunity.id],
    );
    expect(slate.map((s) => s.person_id)).toEqual([ROLE_PEOPLE.staffOne, ROLE_PEOPLE.staffTwo]);

    // The award: the org offers, the agency accepts in Gateway.
    const { applicationId } = await offerToApplication(opportunity.id);
    await page.goto("/work/applications?view=list");
    const card = page.getByRole("listitem").filter({ hasText: opportunity.title });
    await page.waitForLoadState("networkidle");
    await card.getByRole("button", { name: "Accept offer" }).click();
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
    await asPerson(
      PEOPLE.owner,
      `select app.create_engagement_from_application($1, 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', null, null)`,
      [applicationId],
    );

    // The agency's staff are assigned: one engagement per slate member, under the agency.
    const one = await roleEngagement({
      person: ROLE_PEOPLE.staffOne,
      account: ROLE_ACCOUNTS.agency,
      roleType: "Staff",
      rateMinor: 30000,
    });
    const two = await roleEngagement({
      person: ROLE_PEOPLE.staffTwo,
      account: ROLE_ACCOUNTS.agency,
      roleType: "Staff",
      rateMinor: 30000,
    });
    await engagementShift(one.id);

    // Staff One: the briefing waits on the Training tab; positions are not open yet.
    const staff = await browser.newContext({ reducedMotion: "reduce" });
    const s = await staff.newPage();
    await signIn(s, "staff.one@example.com", `/work/engagements/${one.key}/training`);
    await expect(s.getByRole("listitem").filter({ hasText: briefing })).toContainText("To do");
    await expectAccessibleInBothThemes(s);
    await s.goto(`/work/engagements/${one.key}/positions`);
    await expect(s.getByText("5:00", { exact: false })).toHaveCount(0);
    await s.goto(`/work/engagements/${one.key}/onboarding`);
    const step = s.getByRole("listitem").filter({ hasText: briefing });
    await s.waitForLoadState("networkidle");
    await step.getByRole("button", { name: "I have read and acknowledge this" }).click();
    await expect(step.getByText("Acknowledged. The organization verifies it next.")).toBeVisible();

    // Atlas: verification, then Active.
    const atlas = await atlasAs(browser, "producer@example.com");
    await atlas.page.goto(`/${ORG}/opportunities/engagements?id=${one.id}`);
    await atlas.page.getByRole("button", { name: "Record verification" }).first().click();
    await expect(atlas.page.getByText("Passes", { exact: true }).first()).toBeVisible();
    const moveTo = atlas.page.getByRole("form", { name: "Move to" });
    await moveTo.getByLabel("Next state").selectOption("Active");
    await moveTo.getByLabel("Reason").fill("Briefing acknowledged and verified.");
    await moveTo.getByRole("button", { name: "Move" }).click();
    await expect
      .poll(
        async () =>
          (
            await sql<{ s: string }>(
              `select engagement_state::text as s from app.engagements where id = $1`,
              [one.id],
            )
          )[0]?.s,
      )
      .toBe("Active");
    await expectAccessible(atlas.page);
    await atlas.context.close();

    // Now the position shows; Staff Two, who has not acknowledged, cannot be activated.
    await s.goto(`/work/engagements/${one.key}/positions`);
    await expect(s.getByRole("listitem").first()).toBeVisible();
    await expectAccessible(s);
    await staff.close();
    await expect(
      transition("engagement", two.id, "Onboarding", "Active", "Trying without the briefing."),
    ).rejects.toThrow(/onboarding_incomplete|blocking onboarding item/);
  } finally {
    await rules.retire();
  }
});
