import { toDisplayKey } from "@xos/data/gateway-keys";
import { notificationStore, type PlatformDb } from "@xos/platform";
import pg from "pg";
import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import { asPerson, newSignIn, PEOPLE, PROJECT, suffix } from "./role-fixtures";
import { DEMO, expectAccessibleInBothThemes, signIn, sql } from "./support";

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

/** The Accept link of the email inviting someone onto a roster entry, minted by the email worker's store on this stack. */
async function inviteAcceptLink(gatewayUrl: string, entryId: string): Promise<string | undefined> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:56922/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error("Email links are minted against a local stack only.");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const db: PlatformDb = {
      async rpc(fn, args) {
        const names = Object.keys(args);
        const { rows } = await client.query<Record<string, unknown>>(
          `select * from app.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`,
          names.map((n) => args[n]),
        );
        return rows;
      },
      async selectOne(table, columns, match) {
        const keys = Object.keys(match);
        const { rows } = await client.query<Record<string, unknown>>(
          `select ${columns} from app.${table} where ${keys.map((k, i) => `${k} = $${i + 1}`).join(" and ")} limit 1`,
          keys.map((k) => match[k]),
        );
        return rows[0] ?? null;
      },
    };
    const { rows } = await client.query<{ id: string; person: string; org: string }>(
      `select d.id, n.recipient_person_id as person, n.org_id as org from app.notifications n
         join app.notification_deliveries d on d.notification_id = n.id and d.channel = 'Email'
        where n.kind = 'roster_entry.invited' and n.subject_id = $1`,
      [entryId],
    );
    const delivery = rows[0];
    expect(delivery, "the invitation's email delivery").toBeTruthy();
    const store = notificationStore(db, {
      appUrl: process.env["E2E_ATLAS_URL"] ?? "http://127.0.0.1:3006",
      gatewayUrl,
      fromAddress: "notifications@xos.localhost",
      postalAddress: "100 Harbor Way, Miami, FL",
      unsubscribeUrl: async () => `${gatewayUrl}/settings`,
      inboundDomain: null,
    });
    const links = await store.actionLinksFor?.({
      deliveryId: delivery?.id as string,
      orgId: delivery?.org as string,
      recipientPersonId: delivery?.person as string,
      address: "",
      kind: "roster_entry.invited",
      emailTemplateCode: "notification",
      messageArgs: {},
      subjectTable: "engagement_roster_entries",
      subjectId: entryId,
    });
    return links?.find((l) => l.action === "accept")?.url;
  } finally {
    await client.end();
  }
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
      `insert into app.sensitive_data_consents (category, basis, person_id, notice_version, locale, surface, given_by)
       values ('Dietary and Allergies', 'Own Consent', $1, '2026-11-06', 'en-US', 'Gateway', $1)`,
      [memberId],
    );
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

    // The Owner views the profile: dietary needs and allergies only On file (ADR 0164).
    await page.reload();
    await page.getByRole("button", { name: `View the profile of ${memberName}` }).click();
    const profile = page.getByRole("dialog", { name: memberName });
    await expect(profile).toContainText("Allergies");
    await expect(profile).toContainText("On file");
    await expect(profile).not.toContainText("Peanuts");
    await expect(profile).not.toContainText("Vegetarian");
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

/**
 * R11 (RRR-192; A127, ADR 0106): a rostered person accepts their entry from the invitation's email in two taps, the
 * email's Accept and the confirm page's Accept, without opening the record. The link never acts on opening, works once,
 * and leads the person to the same answer Home takes (app.respond_roster_entry).
 */
test("R11: a rostered person accepts their entry from the email action link in two taps", async ({
  page,
  baseURL,
}) => {
  const tag = suffix();
  const memberEmail = `one-tap-${tag.toLowerCase()}@example.com`;
  const owner = await newSignIn(
    `one-tap-owner-${tag.toLowerCase()}@example.com`,
    `Demo Tap Owner ${tag}`,
  );
  const [account] = await asPerson<{ id: string }>(
    owner,
    `select app.create_external_account($1, $2, 'For-Profit') as id`,
    [`Demo Tap Supply ${tag}`, `demo-tap-${tag.toLowerCase()}`],
  );
  const member = await newSignIn(memberEmail, `Demo Tap Member ${tag}`);
  const [membership] = await asPerson<{ id: string }>(
    owner,
    `select app.add_account_member($1, $2, 'Account Member'::app.account_role) as id`,
    [account?.id, member],
  );
  await asPerson(member, "select app.accept_account_membership($1)", [membership?.id]);
  const [counterparty] = await sql<{ id: string }>(
    `insert into app.counterparties (org_id, organization_id) values ($1, $2) returning id`,
    [DEMO.org, account?.id],
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
  try {
    const [entry] = await asPerson<{ id: string }>(
      owner,
      `select app.add_roster_entry($1, $2, '9000.50.02', '2027-06-04 12:00+00', '2027-06-04 14:00+00', 'America/New_York') as id`,
      [engagementId, member],
    );
    const entryId = entry?.id as string;
    await asPerson(owner, "select app.submit_roster($1)", [engagementId]);
    await asPerson(PEOPLE.owner, "select app.review_roster_entry($1, 'Accepted')", [entryId]);

    // The email worker mints the invitation's links, as it does when it sends it.
    const accept = await inviteAcceptLink(baseURL as string, entryId);
    expect(accept).toMatch(/\/auth\/act\/xact_[0-9a-f]{48}\.[0-9a-f]{32}$/);
    const response = async () =>
      (
        await sql<{ response: string }>(
          "select person_response::text as response from app.engagement_roster_entries where id = $1",
          [entryId],
        )
      )[0]?.response;

    // Tap one: the email's Accept opens the confirm page, which only asks.
    await signIn(page, memberEmail, "/home");
    await page.goto(accept as string);
    await expect(
      page.getByRole("heading", { level: 1, name: "Accept your place on this crew?" }),
    ).toBeVisible();
    await expectAccessibleInBothThemes(page);
    expect(await response()).toBe("Pending");

    // Tap two: Accept.
    await expect(async () => {
      await page.getByRole("button", { name: "Accept" }).click({ timeout: 2_000 });
      await expect(page.getByText("Accepted. The organization takes it from here.")).toBeVisible({
        timeout: 5_000,
      });
    }).toPass();
    await expect.poll(response).toBe("Accepted");

    // The link works once.
    await page.goto(accept as string);
    await expect(page.getByText("This was already handled. Nothing else to do.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
  } finally {
    await sql(
      "update app.engagement_roster_entries set deleted_at = now() where engagement_id = $1 and deleted_at is null",
      [engagementId],
    ).catch(() => undefined);
    await sql("update app.engagements set deleted_at = now() where id = $1", [engagementId]).catch(
      () => undefined,
    );
  }
});
