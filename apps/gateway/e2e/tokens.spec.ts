import { expectNoSidewaysScroll } from "./advance-builder";
import { expect, test } from "./engine-test";
import { issueAdvanceLink, issueSigningLink } from "./fixtures";
import { asPerson, newSignIn, offer, PEOPLE, PROJECT, suffix, transition } from "./role-fixtures";
import {
  DEMO,
  DEMO_PASSWORD,
  expectAccessible,
  expectAccessibleInBothThemes,
  reloadSettled,
  signIn,
  sql,
} from "./support";

/**
 * Token flows without an account (Section 4.4.6; Section 20.2, journeys 9 and 50): a signing link
 * and an advance link, each opened by its six-digit access code, then the offer to claim what was
 * submitted into a Gateway account with the same email.
 */
function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

test("a signing link opens with its code and signs once", async ({ page }) => {
  const link = await issueSigningLink();
  await page.goto(`/sign/${link.token}`);
  await expect(page.getByRole("heading", { level: 1, name: "Review and sign" })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  await page.getByLabel("Access code").fill(wrongCode(link.code));
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByText(/That access code does not match/)).toBeVisible();

  await page.getByLabel("Access code").fill(link.code);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByText(link.title)).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Type your full name to sign").fill("Demo Crew");
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(
    page.getByText("Signed by Demo Crew. The organization countersigns next."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Create account" })).toBeVisible();
  await expectAccessible(page);

  // The signature is final: the same link no longer offers to sign.
  await reloadSettled(page);
  await page.getByLabel("Access code").fill(link.code);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByText("Status: Signed")).toBeVisible();
  await expect(page.getByLabel("Type your full name to sign")).toHaveCount(0);
});

test("an advance link is answered section by section and claimed into the account", async ({
  page,
}) => {
  const link = await issueAdvanceLink();
  await page.goto(`/advance/${link.token}`);
  await expect(page.getByRole("heading", { level: 1, name: "Answer your advance" })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Access code").fill(link.code);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: link.title })).toBeVisible();
  await expect(page.getByText("2 sections left")).toBeVisible();
  await expectAccessibleInBothThemes(page);

  for (const [section, answer] of [
    ["1. Equipment", "Two chain hoists, spansets and my own harness."],
    ["2. Arrival", "June 3 at 18:00 by car; I will need a parking pass."],
  ] as const) {
    const item = page
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: section }) });
    await item.getByLabel("Your answer").fill(answer);
    await item.getByRole("button", { name: "Send answer" }).click();
    await expect(item.getByText("Answer sent. The organization reviews it next.")).toBeVisible();
  }
  await expect(page.getByText("Every section is answered")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your advance is complete" })).toBeVisible();

  await page.getByRole("link", { name: "I have an account" }).click();
  await expect(page).toHaveURL(/\/auth\/sign-in\?next=%2Fauth%2Fclaim/);
  await page.locator("#signin-email").fill("crew@example.com");
  // The password field appears on request: the sign-in link is the first choice (A59-025).
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(/\/auth\/claim$/);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Claim submissions" }).click();
  await expect(
    page.getByText(
      /^Done: \d+ advance answers? and \d+ signed documents? are now in your account\.$/,
    ),
  ).toBeVisible();
  await page.getByRole("link", { name: "Go to Home" }).click();
  await expect(page).toHaveURL(/\/home$/);
});

test("an advance section takes one answer until it is returned, then shows why", async ({
  page,
}) => {
  const link = await issueAdvanceLink();
  const open = async () => {
    await page.goto(`/advance/${link.token}`);
    await page.getByLabel("Access code").fill(link.code);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: link.title })).toBeVisible();
  };
  await open();
  const equipment = () =>
    page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "1. Equipment" }) });
  await equipment().getByLabel("Your answer").fill("Two chain hoists.");
  await equipment().getByRole("button", { name: "Send answer" }).click();
  await expect(
    equipment().getByText("Answer sent. The organization reviews it next."),
  ).toBeVisible();

  // A second answer while the first waits for review is refused (migration 2604).
  const [section] = await sql<{ id: string }>(
    `select s.id from app.advance_sections s join app.advance_packets p on p.id = s.advance_packet_id
      where p.title = $1 and s.position = 1`,
    [link.title],
  );
  const [again] = await sql<{ refusal: string | null; reason: string | null }>(
    `select refusal, reason from api_public.submit_advance($1, $2, $3, 'Three chain hoists.')`,
    [link.token, link.code, section?.id],
  );
  expect(again).toEqual({ refusal: "REFUSE", reason: "advance_answer_pending" });

  // The organization returns the answer with a reason; the section shows it and takes an answer again.
  await sql(
    `update app.advance_submissions set reviewed_at = now(), reviewed_by = $2, review_outcome = 'Returned',
       return_reason = 'Say how many spansets you bring.'
     where advance_section_id = $1`,
    [section?.id, DEMO.owner],
    DEMO.owner,
  );
  await open();
  await expect(page.getByText("2 sections left")).toBeVisible();
  await expect(
    equipment().getByText(
      "The organization returned this answer: Say how many spansets you bring.",
    ),
  ).toBeVisible();
  await expectAccessible(page);
  await equipment().getByLabel("Your answer").fill("Two chain hoists and four spansets.");
  await equipment().getByRole("button", { name: "Send answer" }).click();
  await expect(
    equipment().getByText("Answer sent. The organization reviews it next."),
  ).toBeVisible();
});

/**
 * R10 (RRR-191, migrations 2730 and 2731; journey 50): a link without an account reaches what the
 * signed-in Advance tab does. The representative of a vendor company opens the link and code,
 * uploads a rider PDF to a File section, asks for carts on an Item Request, adds a guest within the
 * cap and invites one crew member by email. The production returns the carts answer with a reason,
 * which the link shows, and the section is answered again. The invitee signs up with the invited
 * address and accepts their place; the representative then claims an account, which carries the
 * answers across and makes them the requester of the carts allocation. Each step is checked for
 * accessibility, and the page fits 375 px without sideways scrolling.
 */
test("token advance parity", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const slow = expect.configure({ timeout: 20_000 });
  const tag = suffix();
  const accountName = `Demo Link Vendor ${tag}`;
  const ownerId = await newSignIn(
    `link-owner-${tag.toLowerCase()}@example.com`,
    `Demo Link Owner ${tag}`,
  );
  const [account] = await asPerson<{ id: string }>(
    ownerId,
    `select app.create_external_account($1, $2, 'For-Profit') as id`,
    [accountName, `demo-link-${tag.toLowerCase()}`],
  );
  const [counterparty] = await sql<{ id: string }>(
    `insert into app.counterparties (org_id, organization_id) values ($1, $2) returning id`,
    [DEMO.org, account?.id],
    PEOPLE.owner,
  );
  // Its own project at the demo venue, so offering carts and a guest list touch no other journey.
  const key = `L${Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("")}`;
  const [project] = await sql<{ id: string }>(
    `insert into app.projects (org_id, project_key, name, time_zone, venue_id)
     select $1, $2, $3, 'America/New_York', p.venue_id from app.projects p where p.id = $4
     returning id`,
    [DEMO.org, key, `Link Advance Run ${key}`, PROJECT],
    PEOPLE.owner,
  );
  const projectId = project?.id as string;
  const [engagement] = await sql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
       pay_basis, arrangement, start_date, end_date)
     values ($1, $2, $3, 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-06-04', '2027-06-06')
     returning id`,
    [projectId, ownerId, counterparty?.id],
    PEOPLE.owner,
  );
  const engagementId = engagement?.id as string;
  const repEmail = `link-rep-${tag.toLowerCase()}@example.com`;
  const inviteeEmail = `link-crew-${tag.toLowerCase()}@example.com`;
  const inviteeName = `Demo Link Crew ${tag}`;
  const title = `Link Advance ${tag}`;
  let invitee: { close: () => Promise<void> } | null = null;
  try {
    await transition("engagement", engagementId, "Onboarding", "Active");
    await offer("offerings.carts", projectId);
    await sql(
      `insert into app.offering_rules (org_id, project_id, offering, offering_mode, cap_per_engagement)
       values ($1, $2, 'Guest List', 'Provided', 4)`,
      [DEMO.org, projectId],
      PEOPLE.owner,
    );
    const [carts] = await asPerson<{ id: string }>(
      PEOPLE.owner,
      `select app.ensure_offering_asset_class($1, 'Carts') as id`,
      [DEMO.org],
    );
    const [cartClass] = await sql<{ name: string }>(
      "select name from app.asset_classes where id = $1",
      [carts?.id],
    );
    const cartName = cartClass?.name as string;

    // The production's packet: a File, an Item Request for carts, a Guest List and the Crew Roster.
    const [packet] = await sql<{ id: string }>(
      `insert into app.advance_packets (project_id, title, due_at) values ($1, $2, now() + interval '20 days') returning id`,
      [projectId, title],
      PEOPLE.owner,
    );
    const packetId = packet?.id as string;
    await sql(
      `insert into app.advance_sections (advance_packet_id, position, title, section_kind, max_lines, per_person) values
         ($1, 1, 'Rider', 'File', 2, false), ($1, 2, 'Carts', 'Item Request', 2, false)`,
      [packetId],
      PEOPLE.owner,
    );
    await sql(
      `insert into app.advance_sections (advance_packet_id, position, title, section_kind) values
         ($1, 3, 'Guests', 'Guest List'), ($1, 4, 'Crew', 'Crew Roster')`,
      [packetId],
      PEOPLE.owner,
    );
    await sql(
      `insert into app.advance_section_choices (advance_section_id, asset_class_id)
       select s.id, $2 from app.advance_sections s where s.advance_packet_id = $1 and s.position = 2`,
      [packetId, carts?.id],
      PEOPLE.owner,
    );
    const [recipient] = await sql<{ id: string }>(
      `insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id) values ($1, $2, $3) returning id`,
      [packetId, counterparty?.id, engagementId],
      PEOPLE.owner,
    );
    await sql(`select app.send_advance_packet($1)`, [packetId], PEOPLE.owner);
    const [issued] = await sql<{ token: string; access_code: string }>(
      `select token, access_code from app.issue_advance_token($1, $2)`,
      [recipient?.id, repEmail],
      PEOPLE.owner,
    );
    const linkToken = issued?.token as string;
    const linkCode = issued?.access_code as string;

    // 1. The link and its code.
    const open = async () => {
      await page.goto(`/advance/${linkToken}`);
      await page.getByLabel("Access code").fill(linkCode);
      await page.getByRole("button", { name: "Open", exact: true }).click();
      await slow(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    };
    await open();
    await expectAccessible(page);
    const section = (name: string) =>
      page.getByRole("listitem").filter({ has: page.getByRole("heading", { name }) });
    const sent = "Answer sent. The organization reviews it next.";

    // 2. The rider, the carts, a guest and one crew member.
    const rider = page.getByRole("form", { name: "Rider" });
    await rider.getByLabel("Files").setInputFiles({
      name: "tour-rider.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n% Tour rider, two risers and a dressing room\n%%EOF\n"),
    });
    await rider.getByRole("button", { name: "Send files" }).click();
    await slow(section("1. Rider").getByText(sent)).toBeVisible();
    await slow(section("1. Rider").getByText(/^tour-rider\.pdf · /)).toBeVisible();
    await expectAccessible(page);

    const cartsForm = page.getByRole("form", { name: "Carts" });
    const line = cartsForm.getByRole("group", { name: "Line 1" });
    await line.getByLabel("Item", { exact: true }).selectOption({ label: cartName });
    await line.getByLabel("Quantity", { exact: true }).fill("3");
    await cartsForm.getByRole("button", { name: "Send answer" }).click();
    await slow(section("2. Carts").getByText(sent)).toBeVisible();
    await slow(section("2. Carts").getByText(`3 × ${cartName}`)).toBeVisible();

    const guests = page.getByRole("form", { name: "Ask for guests" });
    await guests.getByLabel("Guest name").fill("Sasha Bell");
    await guests.getByLabel("Plus-ones").fill("1");
    await guests.getByRole("button", { name: "Add guest" }).click();
    await slow(
      page.getByText("Guest added. The production confirms them before the show."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm guest list" }).click();
    await slow(section("3. Guests").getByText(sent)).toBeVisible();

    const invite = page.getByRole("form", { name: "Invite someone by email" });
    await invite.getByLabel("Email").fill(inviteeEmail);
    await invite.getByRole("button", { name: "Send invitation" }).click();
    await slow(
      section("4. Crew").getByRole("status").filter({ hasText: "Invitation sent." }),
    ).toBeVisible();
    // Before they accept, the link shows the invited address masked.
    await slow(
      section("4. Crew").getByText(`l***@example.com · Draft · Invitation sent`),
    ).toBeVisible();
    await expectAccessible(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await expectNoSidewaysScroll(page);
    await page.setViewportSize({ width: 1280, height: 900 });

    // 3. The production returns the carts answer with a reason; the link shows it and takes a new one.
    // Atlas's review (reviewSubmission in packages/data) is this update under the reviewer's own role;
    // Gateway has no review page.
    await asPerson(
      DEMO.owner,
      `update app.advance_submissions x set review_outcome = 'Returned', return_reason = 'Two carts are enough.'
        from app.advance_sections s
       where s.id = x.advance_section_id and s.advance_packet_id = $1 and s.position = 2 and x.review_outcome is null`,
      [packetId],
    );
    await open();
    await slow(
      section("2. Carts").getByText("The organization returned this answer: Two carts are enough."),
    ).toBeVisible();
    await expectAccessible(page);
    const again = page.getByRole("form", { name: "Carts" }).getByRole("group", { name: "Line 1" });
    await again.getByLabel("Item", { exact: true }).selectOption({ label: cartName });
    await again.getByLabel("Quantity", { exact: true }).fill("2");
    await page
      .getByRole("form", { name: "Carts" })
      .getByRole("button", { name: "Send answer" })
      .click();
    await slow(section("2. Carts").getByText(sent)).toBeVisible();
    await slow(page.getByText("Every section is answered")).toBeVisible();

    // 4. The invitee signs up with the invited address and accepts their place on Home.
    await newSignIn(inviteeEmail, inviteeName);
    const inviteeContext = await browser.newContext({ reducedMotion: "reduce" });
    invitee = inviteeContext;
    const inviteePage = await inviteeContext.newPage();
    await signIn(inviteePage, inviteeEmail, "/home");
    const invitation = inviteePage
      .getByRole("listitem")
      .filter({ hasText: `${accountName} invites you onto their crew` });
    await expectAccessible(inviteePage);
    await invitation.getByRole("button", { name: "Accept" }).click();
    await slow
      .poll(async () => {
        const [row] = await sql<{ n: number }>(
          `select count(*)::int as n from app.engagement_roster_entries r
             join app.people p on p.id = r.person_id
            where r.engagement_id = $1 and p.full_name = $2 and r.person_response = 'Accepted' and r.deleted_at is null`,
          [engagementId, inviteeName],
        );
        return row?.n ?? 0;
      })
      .toBe(1);
    await open();
    await slow(section("4. Crew").getByText(`${inviteeName} · Draft · Accepted`)).toBeVisible();
    await page.getByRole("button", { name: "Submit roster" }).click();
    await slow(page.getByText("Sent to the organization for review.")).toBeVisible();

    // 5. The representative claims an account (journey 50): the answers and the carts are theirs.
    const repId = await newSignIn(repEmail, `Demo Link Rep ${tag}`);
    await page.getByRole("link", { name: "I have an account" }).click();
    await expect(page).toHaveURL(/\/auth\/sign-in\?next=%2Fauth%2Fclaim/);
    await page.locator("#signin-email").fill(repEmail);
    await page.getByRole("button", { name: "Use a password" }).click();
    await page.locator("#signin-password").fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await expect(page).toHaveURL(/\/auth\/claim$/);
    await expectAccessible(page);
    await page.getByRole("button", { name: "Claim submissions" }).click();
    await slow(
      page.getByText(
        /^Done: \d+ advance answers? and \d+ signed documents? are now in your account\.$/,
      ),
    ).toBeVisible();
    const mine = await asPerson<{ section_title: string }>(
      repId,
      "select section_title from app.my_advance_submissions() where packet_title = $1",
      [title],
    );
    expect(new Set(mine.map((m) => m.section_title))).toEqual(
      new Set(["Rider", "Carts", "Guests"]),
    );
    // The production's allocation status, as Atlas reads it, names the representative as requester;
    // no column was written at claim.
    const [status] = await asPerson<{ requested_by: string | null }>(
      DEMO.owner,
      `select requested_by from app.advance_allocation_status
        where holder_engagement_id = $1 and item_name = $2 and allocation_state = 'Requested'`,
      [engagementId, cartName],
    );
    expect(status).toEqual({ requested_by: repId });
    const [row] = await sql<{ created_by: string | null }>(
      `select a.created_by from app.advance_allocations a
        where a.engagement_id = $1 and a.asset_class_id = $2 and a.allocation_state = 'Requested' and a.deleted_at is null`,
      [engagementId, carts?.id],
    );
    expect(row).toEqual({ created_by: null });
  } finally {
    await invitee?.close();
    for (const statement of [
      "update app.guest_list_entries set deleted_at = now() where project_id = $1 and deleted_at is null",
      "update app.advance_allocations set deleted_at = now() where project_id = $1 and deleted_at is null",
      "update app.advance_packets set deleted_at = now() where project_id = $1 and deleted_at is null",
      `update app.engagement_roster_entries set deleted_at = now()
        where engagement_id in (select id from app.engagements where project_id = $1) and deleted_at is null`,
      "update app.offering_rules set deleted_at = now() where project_id = $1 and deleted_at is null",
      `update app.setting_values set deleted_at = now()
        where scope_kind = 'Project' and scope_id = $1 and deleted_at is null`,
      "update app.engagements set deleted_at = now() where project_id = $1 and deleted_at is null",
      "update app.projects set deleted_at = now() where id = $1 and deleted_at is null",
    ]) {
      await sql(statement, [projectId]).catch(() => undefined);
    }
  }
});
