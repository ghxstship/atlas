import { toDisplayKey } from "@xos/data/gateway-keys";
import {
  acceptAnswer,
  answerCard,
  expectNoSidewaysScroll,
  sendTypedPacket,
} from "./advance-builder";
import { expect, test } from "./engine-test";
import { completeVendorEngagement } from "./fixtures";
import { asPerson, newSignIn, offer, PEOPLE, PROJECT, suffix, transition } from "./role-fixtures";
import {
  DEMO,
  expectAccessible,
  expectAccessibleInBothThemes,
  reloadSettled,
  signIn,
  sql,
  uniqueId,
} from "./support";

/**
 * Vendor reputation on Gateway (Section 20.2, journey 49): after a Complete engagement the vendor
 * rates the org, both ratings release together, and the vendor answers the org's rating with a
 * public reply on their profile. Ratings cannot be changed once given.
 */
test("a vendor rates a completed engagement and replies to the org's rating", async ({ page }) => {
  const engagement = await completeVendorEngagement();
  const reply = `Thanks for a smooth show ${uniqueId()}.`;
  await signIn(page, "vendor@example.com", `/work/engagements/${engagement.key}/overview`);

  const form = page.getByRole("form", { name: "Rate Demo Productions" });
  await expect(form).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await expect(form.getByRole("button", { name: "Send rating" })).toBeDisabled();
  await form.getByRole("radio", { name: "5 stars" }).click();
  await expect(form.getByRole("radio", { name: "5 stars" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await form.getByLabel("Public comment").fill("Clear advance and fast payment.");
  await form.getByRole("button", { name: "Send rating" }).click();
  await expect(page.getByText(/^Rating sent\./)).toBeVisible();

  await reloadSettled(page);
  await expect(page.getByRole("form", { name: "Rate Demo Productions" })).toHaveCount(0);
  await expect(page.getByText(/^Thanks\. Both ratings appear/)).toBeVisible();

  await page.goto("/profile");
  const rating = page.getByRole("listitem").filter({ hasText: engagement.comment });
  await expect(rating).toBeVisible();
  await expect(rating.getByText("4 of 5")).toBeVisible();
  await expectAccessible(page);
  await rating.getByRole("textbox", { name: "Public reply" }).fill(reply);
  await rating.getByRole("button", { name: "Reply" }).click();
  await expect(rating.getByText("Reply posted.")).toBeVisible();
  await reloadSettled(page);
  await expect(
    page.getByRole("listitem").filter({ hasText: engagement.comment }).getByText(`Reply: ${reply}`),
  ).toBeVisible();
});

/** The R9 journey waits on server actions and two apps, so its assertions get room. */
const slow = expect.configure({ timeout: 20_000 });

/** A confirmed account member of a vendor company made for one run. */
async function accountMember(
  owner: string,
  account: string,
  email: string,
  name: string,
  role: string,
) {
  const person = await newSignIn(email, name);
  const [membership] = await asPerson<{ id: string }>(
    owner,
    `select app.add_account_member($1, $2, $3::app.account_role) as id`,
    [account, person, role],
  );
  await asPerson(person, "select app.accept_account_membership($1)", [membership?.id]);
  return person;
}

/**
 * R9 (RRR-189, ADR 0100 section 8; parity gap G-141): a vendor answers a typed advance. The producing
 * org builds the packet in Atlas (a stage plot File, Radios per person, a Load In window and crew
 * passes for the whole team) and sends it to the vendor under its engagement, with a naming deadline.
 * In Gateway the vendor's Account Admin uploads the stage plot, asks for 6 radios with who carries
 * them, proposes the Load In window and asks for 4 crew passes. Atlas accepts each answer: the radios
 * are Approved, a dock slot is booked from the window, and the vendor's Deliveries tab shows it. The
 * vendor names 2 of the 4 passes, Atlas reads "Named 2 of 4", and once the producer moves the deadline
 * into the past the vendor reads "Names closed" and can no longer assign from the pool.
 */
test("R9: a vendor answers a typed advance, the org books its dock slot, and names close at the deadline", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const tag = suffix();
  const accountName = `Demo Typed Vendor ${tag}`;
  const ownerId = await newSignIn(
    `typed-owner-${tag.toLowerCase()}@example.com`,
    `Demo Typed Owner ${tag}`,
  );
  const [account] = await asPerson<{ id: string }>(
    ownerId,
    `select app.create_external_account($1, $2, 'For-Profit') as id`,
    [accountName, `demo-typed-${tag.toLowerCase()}`],
  );
  const accountId = account?.id as string;
  const adminEmail = `typed-admin-${tag.toLowerCase()}@example.com`;
  const kaiName = `Demo Typed Kai ${tag}`;
  const moName = `Demo Typed Mo ${tag}`;
  const adminId = await accountMember(
    ownerId,
    accountId,
    adminEmail,
    `Demo Typed Admin ${tag}`,
    "Account Admin",
  );
  const kaiId = await accountMember(
    ownerId,
    accountId,
    `typed-kai-${tag.toLowerCase()}@example.com`,
    kaiName,
    "Account Member",
  );
  const moId = await accountMember(
    ownerId,
    accountId,
    `typed-mo-${tag.toLowerCase()}@example.com`,
    moName,
    "Account Member",
  );
  const [counterparty] = await sql<{ id: string }>(
    `insert into app.counterparties (org_id, organization_id) values ($1, $2) returning id`,
    [DEMO.org, accountId],
    PEOPLE.owner,
  );
  // Its own project at the demo venue, so offering radios and booking its dock touch no other journey.
  const key = `V${Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("")}`;
  const projectName = `Typed Advance Run ${key}`;
  const [project] = await sql<{ id: string }>(
    `insert into app.projects (org_id, project_key, name, time_zone, venue_id)
     select $1, $2, $3, 'America/New_York', p.venue_id from app.projects p where p.id = $4
     returning id`,
    [DEMO.org, key, projectName, PROJECT],
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
  const unitTags = Array.from({ length: 6 }, (_, i) => `R9-${tag}-${i + 1}`);
  let atlas: { close: () => Promise<void> } | null = null;
  try {
    await offer("offerings.radios", projectId);
    // Kai and Mo on the roster, accepted by the org and by themselves.
    for (const person of [kaiId, moId]) {
      await asPerson(
        adminId,
        `select app.add_roster_entry($1, $2, '9000.50.02', '2027-06-04 12:00+00', '2027-06-04 14:00+00', 'America/New_York')`,
        [engagementId, person],
      );
    }
    await asPerson(adminId, "select app.submit_roster($1)", [engagementId]);
    const entries = await sql<{ id: string; person_id: string }>(
      `select r.id, rp.person_id from app.engagement_roster_entries r
         join private.roster_people rp on rp.roster_entry_id = r.id
        where r.engagement_id = $1 and r.deleted_at is null`,
      [engagementId],
    );
    for (const entry of entries) {
      await asPerson(PEOPLE.owner, "select app.review_roster_entry($1, 'Accepted')", [entry.id]);
      await asPerson(entry.person_id, "select app.respond_roster_entry($1, 'Accepted')", [
        entry.id,
      ]);
    }
    await transition("engagement", engagementId, "Onboarding", "Active");

    // The org's radios, six units ready to hold, its crew pass and a dock at the project's venue.
    const [radios] = await asPerson<{ id: string }>(
      PEOPLE.owner,
      `select app.ensure_offering_asset_class($1, 'Radios') as id`,
      [DEMO.org],
    );
    for (const assetTag of unitTags) {
      const [unit] = await sql<{ id: string }>(
        `insert into app.asset_units (asset_class_id, asset_tag) values ($1, $2) returning id`,
        [radios?.id, assetTag],
        PEOPLE.owner,
      );
      for (const [from, to] of [
        ["Proposed", "Received"],
        ["Received", "Available"],
      ] as const) {
        await sql(
          `select private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions',
             'asset_unit_id', $1::uuid, $2, $3, 'Moved by the journey fixture.')`,
          [unit?.id, from, to],
          PEOPLE.owner,
        );
      }
    }
    const [radioClass] = await sql<{ name: string }>(
      "select name from app.asset_classes where id = $1",
      [radios?.id],
    );
    const radioName = radioClass?.name as string;
    const passName = `Crew Pass ${tag}`;
    await sql(
      `insert into app.credential_categories (project_id, code, name) values ($1, $2, $3)`,
      [projectId, `CP${tag}`, passName],
      PEOPLE.owner,
    );
    const dockName = `Dock ${tag}`;
    await sql(
      `insert into app.zones (venue_id, code, name)
       select venue_id, $2, $3 from app.projects where id = $1`,
      [projectId, `DOCK-${tag}`, dockName],
      PEOPLE.owner,
    );

    // Atlas builds and sends the packet, with names due in a month's time.
    const packetTitle = `Typed Vendor Advance ${tag}`;
    const sent = await sendTypedPacket(browser, {
      project: `${key} · ${projectName}`,
      title: packetTitle,
      sections: [
        { title: "Stage plot", kind: "File" },
        { title: "Radios", kind: "Item request", perPerson: true, choices: [radioName] },
        { title: "Load in", kind: "Schedule window", windowKind: "Load in" },
        { title: "Crew passes", kind: "Credential request", choices: [passName] },
      ],
      party: `counterparty:${counterparty?.id}`,
      engagementId,
      namesDue: "2027-05-01T12:00",
    });
    atlas = sent.context;
    const producer = sent.page;

    // The vendor's Account Admin answers each section in Gateway.
    const advancePath = `/work/engagements/${toDisplayKey("engagement", engagementId)}`;
    await signIn(page, adminEmail, `${advancePath}/advance`);
    await slow(page.getByRole("heading", { name: packetTitle })).toBeVisible();
    await slow(page.getByText(/^Name your passes by /)).toBeVisible();
    await expectAccessibleInBothThemes(page);

    const sentOk = page
      .getByRole("status")
      .filter({ hasText: "Sent. The organization reviews your answer." });
    const plot = page.getByRole("form", { name: "Stage plot" });
    await plot.getByLabel("Files").setInputFiles({
      name: "stage-plot.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n% Stage plot, riser left of FOH\n%%EOF\n"),
    });
    await plot.getByRole("button", { name: "Send files" }).click();
    await slow(sentOk).toBeVisible();

    await reloadSettled(page);
    const radiosForm = page.getByRole("form", { name: "Radios" });
    await radiosForm.getByRole("button", { name: "Add line" }).click();
    for (const [n, person] of [
      [1, kaiName],
      [2, moName],
    ] as const) {
      const line = radiosForm.getByRole("group", { name: `Line ${n}` });
      await line.getByLabel("Item", { exact: true }).selectOption({ label: radioName });
      await line.getByLabel("Quantity", { exact: true }).fill("3");
      await line.getByLabel("Person", { exact: true }).selectOption({ label: person });
    }
    await radiosForm.getByRole("button", { name: "Send answer" }).click();
    await slow(sentOk).toBeVisible();

    await reloadSettled(page);
    const loadIn = page.getByRole("form", { name: "Load in" });
    const windowOne = loadIn.getByRole("group", { name: "Window 1" });
    await windowOne.getByLabel("Starts", { exact: true }).fill("2027-06-04T08:00");
    await windowOne.getByLabel("Ends", { exact: true }).fill("2027-06-04T10:00");
    await loadIn.getByRole("button", { name: "Send answer" }).click();
    await slow(sentOk).toBeVisible();

    await reloadSettled(page);
    const passes = page.getByRole("form", { name: "Crew passes" });
    const passLine = passes.getByRole("group", { name: "Line 1" });
    await passLine.getByLabel("Pass", { exact: true }).selectOption({ label: passName });
    await passLine.getByLabel("Quantity", { exact: true }).fill("4");
    await passes.getByRole("button", { name: "Send answer" }).click();
    await slow(sentOk).toBeVisible();

    await reloadSettled(page);
    await slow(page.getByText("Awaiting review")).toHaveCount(4);
    await slow(page.getByText(`3 × ${radioName}`)).toHaveCount(2);
    await slow(page.getByText(`4 × ${passName}`)).toBeVisible();
    await slow(page.getByText("stage-plot.pdf")).toBeVisible();
    await expectAccessible(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await reloadSettled(page);
    await expectNoSidewaysScroll(page);
    await page.setViewportSize({ width: 1280, height: 900 });

    // Atlas accepts every answer: the radios are Approved and the window is booked as a dock slot.
    await producer.goto(sent.url);
    for (const section of ["Stage plot", "Radios", "Load in", "Crew passes"]) {
      await acceptAnswer(producer, section, accountName);
    }
    await slow
      .poll(async () => {
        const [row] = await sql<{ n: number }>(
          `select count(*)::int as n from app.advance_allocations a
             join app.engagement_roster_entries r on r.id = a.roster_entry_id
            where r.engagement_id = $1 and a.asset_class_id = $2 and a.allocation_state = 'Approved' and a.deleted_at is null`,
          [engagementId, radios?.id],
        );
        return row?.n ?? 0;
      })
      .toBe(2);
    const loadInCard = answerCard(producer, "Load in", accountName);
    const book = loadInCard.getByRole("form", { name: "Book dock slot" });
    await book
      .getByLabel("Dock", { exact: true })
      .selectOption({ label: `DOCK-${tag} · ${dockName}` });
    await book.getByRole("button", { name: "Book dock slot" }).click();
    await slow(loadInCard.getByText("Dock slot booked.")).toBeVisible();
    await expectAccessible(producer);

    // The vendor reads the dock slot on Deliveries and the radios as approved on Advance.
    await page.goto(`${advancePath}/deliveries`);
    await slow(page.getByText(dockName)).toBeVisible();
    await expectAccessible(page);
    await page.goto(`${advancePath}/advance`);
    await slow(page.getByText("Accepted", { exact: true })).toHaveCount(4);

    // The vendor names 2 of the 4 passes before the deadline.
    await page.goto(`${advancePath}/crew`);
    await page.getByLabel("Assign from", { exact: true }).selectOption({ label: passName });
    const people = page.getByRole("group", { name: "People to assign" });
    await people.getByLabel(`${kaiName}, holds 0`).check();
    await people.getByLabel(`${moName}, holds 0`).check();
    await page
      .getByRole("toolbar", { name: "Bulk actions" })
      .getByRole("button", { name: "Assign to 2 people" })
      .click();
    await page
      .getByRole("dialog", { name: "Assign to 2 people" })
      .getByRole("button", { name: "Assign to 2 people" })
      .click();
    await slow(page.getByText("Assigned to 2 people.")).toBeVisible();
    await producer.reload();
    await slow(
      answerCard(producer, "Crew passes", accountName).getByText("Named 2 of 4"),
    ).toBeVisible();

    // The producer moves the deadline into the past; names close for the vendor.
    await producer.getByText("Set names deadline").click();
    const deadline = producer.getByRole("form", { name: "Save deadline" });
    await deadline.getByLabel("Names due", { exact: true }).fill("2025-01-01T09:00");
    await deadline.getByRole("button", { name: "Save deadline" }).click();
    await slow(producer.getByText("Saved.")).toBeVisible();
    await producer.reload();
    await slow(producer.getByText(/Names closed/)).toBeVisible();

    await page.reload();
    await page.getByLabel("Assign from", { exact: true }).selectOption({ label: passName });
    await slow(page.getByRole("status").filter({ hasText: /^Names closed on / })).toBeVisible();
    await slow(people.getByLabel(`${kaiName}, holds 1`)).toBeDisabled();
    await slow(people.getByLabel(`${moName}, holds 1`)).toBeDisabled();
    await expectAccessible(page);
    await page.goto(`${advancePath}/advance`);
    await slow(page.getByText(/^Names closed on /)).toBeVisible();
  } finally {
    await atlas?.close();
    for (const statement of [
      "update app.dock_slots set deleted_at = now() where project_id = $1 and deleted_at is null",
      "update app.asset_reservations set deleted_at = now() where project_id = $1 and deleted_at is null",
      "update app.advance_allocations set deleted_at = now() where project_id = $1 and deleted_at is null",
      "update app.advance_packets set deleted_at = now() where project_id = $1 and deleted_at is null",
      `update app.engagement_roster_entries set deleted_at = now()
        where engagement_id in (select id from app.engagements where project_id = $1) and deleted_at is null`,
      `update app.setting_values set deleted_at = now()
        where scope_kind = 'Project' and scope_id = $1 and deleted_at is null`,
      "update app.engagements set deleted_at = now() where project_id = $1 and deleted_at is null",
      "update app.projects set deleted_at = now() where id = $1 and deleted_at is null",
    ]) {
      await sql(statement, [projectId]).catch(() => undefined);
    }
    await sql("update app.zones set deleted_at = now() where code = $1 and deleted_at is null", [
      `DOCK-${tag}`,
    ]).catch(() => undefined);
    await sql(
      "update app.asset_units set deleted_at = now() where asset_tag like $1 and deleted_at is null",
      [`R9-${tag}-%`],
    ).catch(() => undefined);
  }
});
