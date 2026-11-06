import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import { DEMO, signIn, sql, uniqueId } from "./support";

/**
 * B10 (RRR-234): the party's side of agreement batches and pool invitations, the steps of journeys 34 and 35 that happen in
 * Gateway. The crew person reads a generated agreement in full and signs with their typed name, and declines another with a
 * reason; Atlas countersigns the signed one, the Automatic Electronic Signature item passes, and the PDF downloads. A pool
 * invitation is accepted on Home, and the person appears by name as an Approved member in Atlas.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 20_000 });

async function batch(tag: string, title: string, body: string, requirement: string | null) {
  const [template] = await sql<{ id: string }>(
    `insert into app.engagement_document_templates (org_id, name, document_kind, title_template, body_template)
     values ($1, $2, 'Agreement', $3, $4) returning id`,
    [DEMO.org, `${title} ${tag}`, title, body],
    DEMO.owner,
  );
  const [created] = await sql<{ answer: { batch_id: string } }>(
    `select app.create_engagement_document_batch($1, $2, $3::jsonb, $4) as answer`,
    [
      DEMO.project,
      template?.id,
      JSON.stringify([{ engagement_id: DEMO.crewEngagement, title, body }]),
      requirement,
    ],
    DEMO.owner,
  );
  const id = created?.answer.batch_id as string;
  await sql(`select app.send_engagement_document_batch($1)`, [id], DEMO.owner);
  return id;
}

test("the crew person signs one agreement and declines another; Atlas countersigns", async ({
  page,
  browser,
}) => {
  const tag = uniqueId().slice(-6);
  await batch(tag, `Sign me ${tag}`, "You work the show days.", null);
  await batch(tag, `Decline me ${tag}`, "A different arrangement.", null);

  await signIn(page, "crew@example.com", `/work/engagements/${DEMO.crewEngagementKey}/documents`);
  const signRow = page.getByRole("listitem").filter({ hasText: `Sign me ${tag}` });
  await expect(signRow.getByText("You work the show days.")).toBeVisible();
  await signRow.getByLabel("Type your full name to sign").fill("Demo Crew");
  await signRow.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(signRow.getByText("Signed").first()).toBeVisible();

  const declineRow = page.getByRole("listitem").filter({ hasText: `Decline me ${tag}` });
  await declineRow.getByRole("button", { name: "Decline", exact: true }).click();
  await declineRow.getByLabel("Why you decline").fill("The dates do not work.");
  await declineRow.getByRole("button", { name: "Decline document" }).click();
  await expect(declineRow.getByText("Canceled").first()).toBeVisible();

  const { context, page: atlas } = await atlasAs(browser, "owner@example.com");
  await atlas.goto(`/${ORG}/opportunities/onboarding`);
  const row = atlas
    .getByRole("listitem")
    .filter({ hasText: `Sign me ${tag}` })
    .first();
  await row.getByRole("button", { name: "Countersign signed" }).click();
  await expect(row.getByText(/Executed: 1/)).toBeVisible();

  await page.reload();
  const download = await Promise.all([
    page.waitForEvent("download"),
    signRow
      .getByRole("link", { name: /PDF|Download/ })
      .first()
      .click(),
  ]);
  expect(download[0].suggestedFilename()).toMatch(/\.pdf$/);
  await context.close();
});

test("a pool invitation is accepted on Home and the person is named in Atlas", async ({
  page,
  browser,
}) => {
  const tag = uniqueId().slice(-6);
  const [pool] = await sql<{ id: string }>(
    `insert into app.talent_pools (org_id, name, pool_kind) values ($1, $2, 'Talent') returning id`,
    [DEMO.org, `Invited ${tag}`],
    DEMO.owner,
  );
  await sql(`select app.invite_to_talent_pool($1, 'crew@example.com')`, [pool?.id], DEMO.owner);

  await signIn(page, "crew@example.com");
  const item = page.getByRole("listitem").filter({ hasText: "invites you to join its crew list" });
  await item.getByRole("button", { name: "Accept" }).click();
  await expect(item).toHaveCount(0);

  const { context, page: atlas } = await atlasAs(browser, "owner@example.com");
  await atlas.goto(`/${ORG}/opportunities/pools?pool=${pool?.id}`);
  await expect(atlas.locator("#pool-members").getByText("Approved").first()).toBeVisible();
  await expect(atlas.locator("#pool-members").getByText("Unnamed")).toHaveCount(0);
  await context.close();
});
