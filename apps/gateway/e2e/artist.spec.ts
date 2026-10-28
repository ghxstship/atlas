import { expect as baseExpect, test } from "./engine-test";
import {
  artistAdvance,
  asPerson,
  offerToApplication,
  PEOPLE,
  PROJECT,
  publishArtistCall,
  ROLE_PEOPLE,
  submittedSettlement,
  transition,
} from "./role-fixtures";
import { atlasAs, ORG } from "./atlas";
import { expectAccessible, expectAccessibleInBothThemes, signIn, sql } from "./support";
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
