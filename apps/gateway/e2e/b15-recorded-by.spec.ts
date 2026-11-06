import { expect as baseExpect, test } from "./engine-test";
import {
  asPerson,
  PEOPLE,
  ROLE_ACCOUNTS,
  ROLE_PEOPLE,
  roleEngagement,
  suffix,
} from "./role-fixtures";
import { DEMO, expectAccessibleInBothThemes, signIn, sql } from "./support";

/**
 * B15 (RRR-239, ADR 0154 D1): an answer the org recorded from an Aurora draft carries a recorded-by
 * label on the party's Advance tab, in en-US and es-US, so a party held back by
 * advance_answer_pending can see why and ask for it back.
 *
 * The draft is recorded through the database's own path, as the Owner: a drafting request about the
 * recipient, one proposed answer, then app.record_drafted_advance_answer, so no model or Aurora
 * fixture server is needed. The packet, its two Text sections and the inbox message are fixtures.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

/** Records one drafted Text answer for the recipient, as the Owner, and returns the answer id. */
async function recordDraft(
  recipient: string,
  section: string,
  text: string,
  source: { inbound_message_id: string } | { file_name: string },
): Promise<string> {
  const [request] = await asPerson<{ id: string }>(
    PEOPLE.owner,
    "select app.ai_begin_request($1, 'drafting', 'fixture', 'app.advance_recipients', $2) as id",
    [DEMO.org, recipient],
  );
  await asPerson(
    PEOPLE.owner,
    "select app.ai_complete_request($1, 'Answered', 'Draft answers from [document text/plain].', 'Drafted.', 100, 40)",
    [request?.id],
  );
  const fromMail = "inbound_message_id" in source;
  const [suggestion] = await asPerson<{ id: string }>(
    PEOPLE.owner,
    "select app.ai_propose_suggestion($1, 'advanceAnswers.record', $2, 'Answer the section.', $3::jsonb) as id",
    [
      request?.id,
      section,
      JSON.stringify([
        {
          field_path: "source_kind",
          value: fromMail ? "Project Inbox" : "File",
          confidence: 0.8,
          source_excerpt: text,
        },
        fromMail
          ? { field_path: "inbound_message_id", value: source.inbound_message_id, confidence: 1 }
          : { field_path: "file_name", value: source.file_name, confidence: 1 },
        { field_path: "text", value: text, confidence: 0.8 },
      ]),
    ],
  );
  const [answer] = await asPerson<{ id: string }>(
    PEOPLE.owner,
    "select app.record_drafted_advance_answer($1, '{}'::jsonb) as id",
    [suggestion?.id],
  );
  return answer?.id as string;
}

test("recorded-by label on an answer the org recorded from an Aurora draft", async ({ page }) => {
  const tag = suffix();
  const engagement = await roleEngagement({
    person: ROLE_PEOPLE.contractor,
    account: ROLE_ACCOUNTS.studio,
    roleType: "Contractor",
    roleCode: "9000.50.03",
  });
  const [org] = await sql<{ name: string }>("select name from app.organizations where id = $1", [
    DEMO.org,
  ]);
  const orgName = org?.name ?? "";
  const [settings] = await sql<{ drafting_enabled: boolean }>(
    "select drafting_enabled from app.ai_settings where org_id = $1",
    [DEMO.org],
  );
  const [inbox] = await sql<{ id: string }>(
    `select id from app.inbound_addresses
      where project_id = $1 and disabled_at is null and deleted_at is null`,
    [DEMO.project],
  );
  const parking = `Parking ${tag}`;
  const loadIn = `Load in notes ${tag}`;
  let packet: string | undefined;
  let message: string | undefined;
  try {
    await sql(
      `insert into app.ai_settings (org_id, drafting_enabled) values ($1, true)
        on conflict (org_id) do update set drafting_enabled = true`,
      [DEMO.org],
      PEOPLE.owner,
    );
    const [created] = await sql<{ id: string }>(
      "insert into app.advance_packets (project_id, title) values ($1, $2) returning id",
      [DEMO.project, `Contractor Advance ${tag}`],
      PEOPLE.owner,
    );
    packet = created?.id;
    const sections = await sql<{ id: string; title: string }>(
      `insert into app.advance_sections (advance_packet_id, position, title, prompt, section_kind)
        values ($1, 1, $2, 'Where do your vans park?', 'Text'), ($1, 2, $3, 'Anything we should know for load in?', 'Text')
        returning id, title`,
      [packet, parking, loadIn],
      PEOPLE.owner,
    );
    const sectionId = (title: string) => sections.find((s) => s.title === title)?.id as string;
    const [recipient] = await sql<{ id: string }>(
      `insert into app.advance_recipients (advance_packet_id, person_id, engagement_id)
        values ($1, $2, $3) returning id`,
      [packet, ROLE_PEOPLE.contractor, engagement.id],
      PEOPLE.owner,
    );
    await asPerson(PEOPLE.owner, "select app.send_advance_packet($1)", [packet]);

    // One answer from verified project inbox mail, one from a file the Owner picked.
    const [local] = await asPerson<{ local: string }>(
      PEOPLE.owner,
      "select app.create_project_inbox($1) as local",
      [DEMO.project],
    );
    const [received] = await sql<{ id: string }>(
      `select app.receive_inbound_email($1, 'advance@studio.test', 'Parking for the crew', $2, true,
        'We park two vans at Gate B.', $3) as id`,
      [local?.local, `<b15-${tag}@studio.test>`, `raw/b15-${tag}.eml`],
    );
    message = received?.id;
    await recordDraft(recipient?.id as string, sectionId(parking), "We park two vans at Gate B.", {
      inbound_message_id: message as string,
    });
    const fromFile = await recordDraft(
      recipient?.id as string,
      sectionId(loadIn),
      "Two trucks at 07:00.",
      { file_name: "tour-book.pdf" },
    );

    // en-US.
    await signIn(page, "contractor@example.com", `/work/engagements/${engagement.key}/advance`);
    const label = (title: string) =>
      page.getByRole("listitem").filter({ hasText: title }).getByTestId("recorded-by-producer");
    const SENTENCE = `Recorded by ${orgName} from your message. Ask them to return it if it needs changing.`;
    await expect(label(parking)).toHaveText(SENTENCE);
    await expect(label(loadIn)).toHaveText(SENTENCE);
    await expectAccessibleInBothThemes(page);

    // The accepter cannot review what they recorded; another reviewer accepts it.
    const review = `update app.advance_submissions
        set reviewed_at = now(), reviewed_by = $2, review_outcome = 'Accepted'
      where id = $1 and reviewed_at is null`;
    await expect(asPerson(PEOPLE.owner, review, [fromFile, PEOPLE.owner])).rejects.toThrow(
      /sod_advance_submitter/,
    );
    await asPerson(PEOPLE.admin, review, [fromFile, PEOPLE.admin]);

    // es-US. The cookie is set for the origin, not the page's directory.
    await page
      .context()
      .addCookies([{ name: "xos-locale", value: "es-US", url: new URL(page.url()).origin }]);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "es-US");
    await expect(label(parking)).toHaveText(
      `${orgName} lo registró a partir de tu mensaje. Pídele que lo devuelva si necesita cambios.`,
    );
  } finally {
    if (message) {
      await asPerson(PEOPLE.owner, "select app.discard_inbound_message($1, $2)", [
        message,
        "End-to-end fixture.",
      ]).catch(() => undefined);
    }
    if (!inbox) {
      await sql(
        `update app.inbound_addresses set disabled_at = now()
          where project_id = $1 and disabled_at is null and deleted_at is null`,
        [DEMO.project],
      ).catch(() => undefined);
    }
    if (packet) {
      await sql("update app.advance_packets set deleted_at = now() where id = $1", [packet]).catch(
        () => undefined,
      );
    }
    await sql("update app.ai_settings set drafting_enabled = $2 where org_id = $1", [
      DEMO.org,
      settings?.drafting_enabled ?? false,
    ]).catch(() => undefined);
  }
});
