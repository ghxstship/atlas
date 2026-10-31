import { expectNoSidewaysScroll, sendTypedPacket } from "./advance-builder";
import { expect as baseExpect, test } from "./engine-test";
import {
  artistAdvance,
  asPerson,
  offer,
  offerToApplication,
  PEOPLE,
  PROJECT,
  publishArtistCall,
  roleEngagement,
  ROLE_PEOPLE,
  submittedSettlement,
  suffix,
  transition,
} from "./role-fixtures";
import { atlasAs, ORG } from "./atlas";
import { DEMO, expectAccessible, expectAccessibleInBothThemes, signIn, sql } from "./support";
import { toDisplayKey } from "@xos/data/gateway-keys";

/**
 * Journey 45 (Section 20.2), artist: the open call receives the artist's submission with her
 * fee and press kit; her representative (Demo Talent Agency, all four scopes, seed 1080) accepts
 * the offer for her, answers the advance and reads the rider and set time; the artist's set time
 * and guest list are what Compass reads for her (their server half: the same views as her, the
 * screens need a device); and the representative accepts the settlement, which closes the
 * engagement.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("journey 45: open call, representative accepts, advance, set time and settlement", async ({
  page,
  browser,
}) => {
  const call = await publishArtistCall();

  // The artist submits to the open call with her fee; her EPK goes with it from her profile.
  await signIn(page, "artist@example.com", `/explore/${call.key}`);
  const form = page.getByRole("form", { name: `Apply for ${call.title}` });
  await expect(
    form.getByText("The organization sees the EPK from your profile once you apply."),
  ).toBeVisible();
  await expectAccessible(page);
  await form.getByLabel(/^Your fee/).fill("2500.00");
  await form.getByLabel("I am available for these dates").check();
  await form.getByRole("button", { name: "Send application" }).click();
  await expect(page.getByText(/You applied on|Application sent/).first()).toBeVisible();
  const [submitted] = await sql<{ fee: string }>(
    `select proposed_fee_minor::text as fee from app.applications where opportunity_id = $1`,
    [call.id],
  );
  expect(submitted?.fee).toBe("250000");

  // The org offers; the representative accepts it for the artist.
  const { applicationId } = await offerToApplication(call.id, {
    rateType: "Flat",
    amountMinor: 250000,
    starts: "2027-06-05",
    ends: "2027-06-05",
    message: "Support set, 45 minutes, opening night.",
  });
  const agent = await browser.newContext({ reducedMotion: "reduce" });
  const a = await agent.newPage();
  await signIn(a, "agent@example.com", "/work/applications");
  await a.goto("/work/applications?view=list");
  const card = a.getByRole("listitem").filter({ hasText: call.title });
  await expect(card).toBeVisible();
  await expectAccessibleInBothThemes(a);
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

  const [eng] = await asPerson<{ id: string }>(
    PEOPLE.owner,
    `select app.create_engagement_from_application($1, 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', null, null) as id`,
    [applicationId],
  );
  const engagementId = eng?.id as string;
  const key = toDisplayKey("engagement", engagementId);
  await transition("engagement", engagementId, "Onboarding", "Active", "Contract signed.");
  const advance = await artistAdvance(ROLE_PEOPLE.artist);

  // The Producer sets the Opening Night cue for the artist in Atlas Show > Run of show (R1).
  const [cue] = await sql<{ id: string; label: string; run: string }>(
    `select c.id, c.label, r.id as run from app.cues c join app.run_of_show r on r.id = c.run_of_show_id
      where r.project_id = $1 and r.name = 'Opening Night Running Order' and c.deleted_at is null
        and c.called_at is null
      order by c.position limit 1`,
    [PROJECT],
  );
  const set = { label: cue?.label as string };
  const producer = await atlasAs(browser, "producer@example.com");
  await producer.page.goto(`/${ORG}/show/run-of-show?peek=${cue?.run}`);
  await producer.page.locator(`#set-for-${cue?.id}`).selectOption(engagementId);
  await expect
    .poll(
      async () =>
        (
          await sql<{ n: number }>(
            `select count(*)::int as n from app.engagement_cues
              where engagement_id = $1 and cue_id = $2 and deleted_at is null`,
            [engagementId, cue?.id],
          )
        )[0]?.n,
    )
    .toBe(1);
  await producer.context.close();

  // The representative answers the advance and reads the rider and the set time.
  await a.goto(`/work/engagements/${key}/advance`);
  const packet = a
    .locator("section")
    .filter({ has: a.getByRole("heading", { name: advance.title }) })
    .last();
  const section = packet.getByRole("form", { name: "Backline" });
  await expect(packet.getByText(advance.prompt)).toBeVisible();
  await section
    .getByLabel("Your answer")
    .fill("Drum riser 8x8, two DI boxes, our own guitar amps.");
  await section.getByRole("button", { name: "Send answer" }).click();
  await expect(a.getByText("Answer sent. The organization reviews it next.")).toBeVisible();
  await a.goto(`/work/engagements/${key}/rider`);
  await expectAccessible(a);
  await a.goto(`/work/engagements/${key}/set-times`);
  await expect(a.getByText(set.label).first()).toBeVisible();
  // The guest list tab opens only where the project offers a guest list (R3).
  await offer("offerings.guest_list");
  await a.goto(`/work/engagements/${key}/guest-list`);
  await a.getByLabel("Guest name").fill("Jordan Reyes");
  await a.getByRole("button", { name: "Add guest" }).click();
  await expect(
    a.getByText("Guest added. The production confirms them before the show."),
  ).toBeVisible();

  // What Compass reads for the artist: her set and her guest list.
  const compass = await asPerson<{ cues: string; guests: string }>(
    ROLE_PEOPLE.artist,
    `select (select count(*) from api_external.cues where is_my_set)::text as cues,
            (select count(*) from app.engaged_guest_list($1) g where g.guest_name = 'Jordan Reyes')::text as guests`,
    [engagementId],
  );
  expect(compass[0]?.cues).not.toBe("0");
  expect(compass[0]?.guests).toBe("1");

  // Settlement: the representative accepts it and the engagement closes.
  const settlement = await submittedSettlement(engagementId);
  await a.goto(`/work/engagements/${key}/settlement`);
  await expect(a.getByText("Net to you: $2,800.00")).toBeVisible();
  const respond = a.getByRole("form", { name: settlement.title });
  await respond.locator("textarea").fill("Agreed, thank you.");
  await respond.locator('button[type="submit"]').click();
  await expect(a.getByText("Answer sent. The organization sees it now.")).toBeVisible();
  await expectAccessible(a);
  await agent.close();
  const [accepted] = await sql<{ s: string }>(
    `select settlement_state::text as s from app.settlements where id = $1`,
    [settlement.id],
  );
  expect(accepted?.s).toBe("Accepted");
  await transition("settlement", settlement.id, "Accepted", "Paid", "Paid by wire.");
  await transition("engagement", engagementId, "Active", "Closing", "Show played.");
  await transition("engagement", engagementId, "Closing", "Complete", "Settled and paid.");
  const [closed] = await sql<{ s: string }>(
    `select engagement_state::text as s from app.engagements where id = $1`,
    [engagementId],
  );
  expect(closed?.s).toBe("Complete");
});

test("R2: an individual artist reads the rider Atlas assigned to their engagement", async ({
  page,
}) => {
  const engagement = await roleEngagement({ person: ROLE_PEOPLE.artist, roleType: "Artist" });
  await transition("engagement", engagement.id, "Onboarding", "Active", "Artist confirmed.");
  const title = `Technical Rider ${engagement.key.slice(-4)}`;
  const [rider] = await sql<{ id: string }>(
    `insert into app.riders (project_id, engagement_id, title) values ($1, $2, $3) returning id`,
    [PROJECT, engagement.id, title],
    PEOPLE.owner,
  );
  await sql(
    `insert into app.rider_lines (rider_id, description, quantity) values ($1, 'Two wedge monitors', 2)`,
    [rider?.id],
    PEOPLE.owner,
  );
  await signIn(page, "artist@example.com", `/work/engagements/${engagement.key}/rider`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("Two wedge monitors")).toBeVisible();
  await expectAccessible(page);
});

/**
 * R9 (RRR-189, migration 2715): the guest list cap on an artist's advance. The run makes its own
 * project, so its cap of three places per engagement touches no other journey. The org sends a packet
 * with a Guest List section; the artist reads how many places are used of the cap, plus-ones
 * included, fills it with one guest and two plus-ones, is refused the next guest, and confirms the
 * list.
 */
test("R9: the guest list cap is shown on the advance and enforced", async ({ page, browser }) => {
  const tag = suffix();
  const key = `G${Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("")}`;
  const name = `Guest Cap Run ${key}`;
  const [project] = await sql<{ id: string }>(
    `insert into app.projects (org_id, project_key, name, time_zone)
     values ($1, $2, $3, 'America/New_York') returning id`,
    [DEMO.org, key, name],
    PEOPLE.owner,
  );
  const projectId = project?.id as string;
  let atlas: { close: () => Promise<void> } | null = null;
  try {
    await sql(
      `insert into app.offering_rules (org_id, project_id, offering, offering_mode, cap_per_engagement)
       values ($1, $2, 'Guest List', 'Provided', 3)`,
      [DEMO.org, projectId],
      PEOPLE.owner,
    );
    const [engagement] = await sql<{ id: string }>(
      `insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis,
         arrangement, currency_code, start_date, end_date)
       values ($1, $2, 'Artist', '2000.50.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 'USD',
         '2027-06-04', '2027-06-06')
       returning id`,
      [projectId, ROLE_PEOPLE.artist],
      PEOPLE.owner,
    );
    const engagementId = engagement?.id as string;
    await transition("engagement", engagementId, "Onboarding", "Active");
    const guests = `Guests ${tag}`;
    const sent = await sendTypedPacket(browser, {
      project: `${key} · ${name}`,
      title: `Artist Advance ${tag}`,
      sections: [{ title: guests, kind: "Guest list" }],
      party: `person:${ROLE_PEOPLE.artist}`,
      engagementId,
    });
    atlas = sent.context;

    await signIn(
      page,
      "artist@example.com",
      `/work/engagements/${toDisplayKey("engagement", engagementId)}/advance`,
    );
    await expect(page.getByText("0 of 3 places used, plus-ones included.")).toBeVisible();
    await expectAccessibleInBothThemes(page);
    const add = page.getByRole("form", { name: "Add a guest" });
    await add.getByLabel("Guest name").fill("Sasha Bell");
    await add.getByLabel("Plus-ones").fill("2");
    await add.getByRole("button", { name: "Add guest" }).click();
    await expect(
      page.getByText("Guest added. The production confirms them before the show."),
    ).toBeVisible();

    await page.reload();
    await expect(page.getByText("3 of 3 places used, plus-ones included.")).toBeVisible();
    await add.getByLabel("Guest name").fill("Rowan Hale");
    await add.getByRole("button", { name: "Add guest" }).click();
    await expect(page.getByText(/^Your guest list is full, plus-ones included\./)).toBeVisible();
    const [count] = await sql<{ n: number }>(
      `select count(*)::int as n from app.guest_list_entries where engagement_id = $1 and deleted_at is null`,
      [engagementId],
    );
    expect(count?.n).toBe(1);

    await page
      .getByRole("form", { name: guests })
      .getByRole("button", { name: "Confirm guest list" })
      .click();
    await expect(page.getByText("Sent. The organization reviews your answer.")).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await expect(page.getByText("You confirmed the guest list.")).toBeVisible();
    await expectNoSidewaysScroll(page);
  } finally {
    await atlas?.close();
    for (const statement of [
      `update app.guest_list_entries set deleted_at = now()
        where engagement_id in (select id from app.engagements where project_id = $1) and deleted_at is null`,
      "update app.advance_packets set deleted_at = now() where project_id = $1 and deleted_at is null",
      "update app.offering_rules set deleted_at = now() where project_id = $1 and deleted_at is null",
      "update app.engagements set deleted_at = now() where project_id = $1 and deleted_at is null",
      "update app.projects set deleted_at = now() where id = $1 and deleted_at is null",
    ]) {
      await sql(statement, [projectId]).catch(() => undefined);
    }
  }
});
