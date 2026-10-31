import { toDisplayKey } from "@xos/data/gateway-keys";
import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import { asPerson, newSignIn, PEOPLE, PROJECT, suffix } from "./role-fixtures";
import { DEMO, signIn, sql } from "./support";

/**
 * R4 (RRR-182, owner decisions 0/1, 4 and 6): a vendor company's crew roster, end to end.
 *   - The vendor's Account Owner invites a team member by email on Company, Team. The member signs
 *     in to Gateway with that address and accepts the invitation on Home.
 *   - As an unassigned Account Member they get 404 on the vendor engagement; once the Owner assigns
 *     them with the Member duty on the Overview, they reach it.
 *   - The Owner adds them from the team on the Crew tab and submits the roster; the demo Owner
 *     accepts the entry in Atlas, Advancing, Crew roster.
 *   - The member accepts the entry on Home and shares their work details; the Owner views the profile
 *     on the Crew tab, where allergies show as On file (a company reader never reads them).
 * The vendor company, its people and its engagement are new on every run; the engagement and its
 * entries are removed afterwards so the demo project's roster stays as the seed left it.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 20_000 });

/** The member's live entry on the engagement; a condition is appended. */
const MEMBER_ENTRY = `select count(*)::int as n from app.engagement_roster_entries
  where engagement_id = $1 and person_id = $2 and deleted_at is null`;

/** A count read as postgres from the local stack. */
async function count(text: string, params: unknown[]): Promise<number> {
  const [row] = await sql<{ n: number }>(text, params);
  return row?.n ?? 0;
}

test("crew roster: invite, confirm, assign, roster, review, accept and the masked profile", async ({
  page,
  browser,
}) => {
  const tag = suffix();
  const ownerEmail = `crew-owner-${tag.toLowerCase()}@example.com`;
  const memberEmail = `crew-member-${tag.toLowerCase()}@example.com`;
  const accountName = `Demo Crew Supply ${tag}`;
  const memberName = `Demo Crew Member ${tag}`;
  const owner = await newSignIn(ownerEmail, `Demo Crew Owner ${tag}`);
  const [account] = await asPerson<{ id: string }>(
    owner,
    `select app.create_external_account($1, $2, 'For-Profit') as id`,
    [accountName, `demo-crew-${tag.toLowerCase()}`],
  );
  const accountId = account?.id as string;
  const [counterparty] = await sql<{ id: string }>(
    `insert into app.counterparties (org_id, organization_id) values ($1, $2) returning id`,
    [DEMO.org, accountId],
    PEOPLE.owner,
  );
  const [engagement] = await sql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
       pay_basis, arrangement, start_date, end_date)
     values ($1, $2, $3, 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-06-04', '2027-06-06')
     returning id`,
    [PROJECT, owner, counterparty?.id],
    PEOPLE.owner,
  );
  const engagementId = engagement?.id as string;
  const engagementPath = `/work/engagements/${toDisplayKey("engagement", engagementId)}`;
  try {
    // The Owner, acting as the company, invites the member by email.
    await signIn(page, ownerEmail, "/home");
    await page.context().addCookies([{ name: "xos-acting", value: accountId, url: page.url() }]);
    await page.goto("/settings/company/team-and-account-roles");
    const invite = page.getByRole("form", { name: "Invite someone to your company" });
    await invite.getByLabel("Email").fill(memberEmail);
    await invite.getByRole("button", { name: "Send invitation" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Invitation sent. It stays open for 14 days." }),
    ).toBeVisible();
    const [queued] = await sql<{ n: number }>(
      `select count(*)::int as n from private.platform_emails
        where template = 'party_invitation' and to_email = $1`,
      [memberEmail],
    );
    expect(queued?.n).toBe(1);

    // The member signs in with that address and accepts on Home.
    const memberId = await newSignIn(memberEmail, memberName);
    const member = await browser.newContext({ reducedMotion: "reduce" });
    const memberPage = await member.newPage();
    await signIn(memberPage, memberEmail, "/home");
    const invitation = memberPage
      .getByRole("listitem")
      .filter({ hasText: `${accountName} invites you to their company account` });
    await invitation.getByRole("button", { name: "Accept" }).click();
    await expect
      .poll(() =>
        count(
          `select count(*)::int as n from app.account_memberships
            where org_id = $1 and person_id = $2 and accepted_at is not null and deleted_at is null`,
          [accountId, memberId],
        ),
      )
      .toBe(1);

    // Unassigned, the member does not reach the engagement; assigned as a Member, they do.
    expect((await memberPage.goto(engagementPath))?.status()).toBe(404);
    await page.goto(engagementPath);
    const assign = page.getByRole("form", { name: "Assign a member to this engagement" });
    await assign.getByLabel("Member", { exact: true }).selectOption({ label: memberName });
    await assign.getByRole("button", { name: "Assign" }).click();
    await expect
      .poll(() =>
        count(
          `select count(*)::int as n from app.account_engagement_assignments
            where engagement_id = $1 and duty = 'Member' and deleted_at is null`,
          [engagementId],
        ),
      )
      .toBe(1);
    await page.reload();
    await expect(
      page.getByRole("list", { name: "Account team" }).getByText(memberName),
    ).toBeVisible();
    expect((await memberPage.goto(engagementPath))?.status()).toBe(200);

    // The Owner adds the member from the team and submits the roster.
    await page.goto(`${engagementPath}/crew`);
    const add = page.getByRole("form", { name: "Add someone from your team" });
    await add.getByLabel("Person").selectOption({ label: memberName });
    await add.getByRole("button", { name: "Add to roster" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Added. They are asked to accept on Gateway Home." }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Submit roster (1 entry)" }).click();
    await expect
      .poll(() => count(`${MEMBER_ENTRY} and entry_state = 'Submitted'`, [engagementId, memberId]))
      .toBe(1);

    // The demo Owner accepts the entry in Atlas.
    const atlas = await atlasAs(browser, "owner@example.com");
    await atlas.page.goto(`/${ORG}/p/NWS/advancing?section=crew`);
    const entry = atlas.page
      .getByRole("region", { name: accountName })
      .getByRole("listitem")
      .filter({ hasText: memberName });
    await entry.getByRole("button", { name: "Accept" }).click();
    await expect(entry).toContainText("Accepted");
    await atlas.context.close();

    // The member accepts the entry on Home and shares work details, allergies included.
    await sql(
      `insert into app.person_work_details (person_id, dietary_needs, allergies)
       values ($1, '{Vegetarian}', 'Peanuts, anaphylaxis')`,
      [memberId],
    );
    await memberPage.goto("/home");
    const rostered = memberPage
      .getByRole("listitem")
      .filter({ hasText: `${accountName} put you on their crew` });
    await expect(rostered).toContainText("Accepting lets the company see your profile");
    await rostered.getByRole("button", { name: "Accept" }).click();
    await expect
      .poll(() =>
        count(`${MEMBER_ENTRY} and person_response = 'Accepted'`, [engagementId, memberId]),
      )
      .toBe(1);
    await memberPage.goto("/settings/work-details");
    const sharing = memberPage.getByRole("region", { name: "Sharing with engagements" });
    const choose = sharing.getByRole("form", { name: /Categories to share with Demo Productions/ });
    await choose.getByLabel("Dietary needs").check();
    await choose.getByRole("button", { name: "Share selected" }).click();
    await expect
      .poll(() =>
        count(
          `select count(*)::int as n from app.work_detail_shares
            where engagement_id = $1 and person_id = $2 and revoked_at is null and deleted_at is null`,
          [engagementId, memberId],
        ),
      )
      .toBe(1);
    await member.close();

    // The Owner views the profile: dietary needs, with allergies only On file.
    await page.reload();
    await page.getByRole("button", { name: `View the profile of ${memberName}` }).click();
    const profile = page.getByRole("dialog", { name: memberName });
    await expect(profile).toContainText("Allergies");
    await expect(profile).toContainText("On file");
    await expect(profile).not.toContainText("Peanuts");
  } finally {
    await sql(
      `update app.work_detail_shares set revoked_at = coalesce(revoked_at, now()), deleted_at = now()
        where engagement_id = $1 and deleted_at is null`,
      [engagementId],
    );
    await sql(
      `update app.engagement_roster_entries set deleted_at = now()
        where engagement_id = $1 and deleted_at is null`,
      [engagementId],
    );
    await sql(
      `update app.account_engagement_assignments set deleted_at = now()
        where engagement_id = $1 and deleted_at is null`,
      [engagementId],
    );
    await sql("update app.engagements set deleted_at = now() where id = $1", [engagementId]);
  }
});
