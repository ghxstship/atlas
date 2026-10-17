import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import {
  asPerson,
  PEOPLE,
  ROLE_ACCOUNTS,
  ROLE_PEOPLE,
  roleEngagement,
  sentDocument,
  sponsorEntitlement,
  suffix,
  transition,
} from "./role-fixtures";
import { DEMO, expectAccessible, expectAccessibleInBothThemes, signIn, sql } from "./support";

/**
 * Journey 47 (Section 20.2), sponsor: the sponsor accepts the sponsorship package, returns and then approves the
 * banner artwork in Gateway, sees the entitlement fulfilled once the crew captures it with photos
 * (the Compass capture's server half: the fulfillment and its photo evidence recorded by the
 * Field lead), receives the proof-of-performance report, and that report is the evidence that
 * satisfies gate 8's sponsor criterion in Atlas.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("journey 47: package, asset approval, fulfillment and proof of performance for gate 8", async ({
  page,
  browser,
}) => {
  const engagement = await roleEngagement({
    person: ROLE_PEOPLE.sponsor,
    account: ROLE_ACCOUNTS.sponsor,
    roleType: "Sponsor",
  });
  const tag = suffix();
  const pkg = `Main Stage Sponsorship Package ${tag}`;
  await sentDocument(engagement.id, "Offer", pkg);

  // The sponsor accepts the package.
  await signIn(page, "sponsor@example.com", `/work/engagements/${engagement.key}/documents`);
  const pkgRow = page.getByRole("listitem").filter({ hasText: pkg });
  await expect(pkgRow).toBeVisible();
  await expectAccessible(page);
  await pkgRow.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(pkgRow.getByText("Signed. The organization countersigns next.")).toBeVisible();
  await transition("engagement", engagement.id, "Onboarding", "Active", "Package accepted.");

  // Entitlement of the package, open on the sponsor's Entitlements tab.
  const entitlement = `Logo on main stage screen ${tag}`;
  const ent = await sponsorEntitlement(entitlement);
  await page.goto(`/work/engagements/${engagement.key}/entitlements`);
  await expect(page.getByRole("listitem").filter({ hasText: entitlement })).toContainText("Open");
  await expectAccessibleInBothThemes(page);

  // Assets, approved in Gateway (migration 1133, finding A38-005): the org submits the banner
  // artwork; the sponsor returns it with what to change, the org resubmits a revision and the
  // sponsor approves it. The org's own creator still cannot approve it (separation of duties).
  const assetTitle = `Main stage banner artwork ${tag}`;
  const [asset] = await sql<{ id: string }>(
    `insert into app.sponsor_assets (sponsor_entitlement_id, asset_kind, title, due_on)
     values ($1, 'Logo', $2, '2027-05-20') returning id`,
    [ent.id, assetTitle],
    PEOPLE.owner,
  );
  await page.goto(`/work/engagements/${engagement.key}/asset-approvals`);
  await expect(page.getByRole("listitem").filter({ hasText: assetTitle })).toHaveCount(0);
  await asPerson(
    PEOPLE.owner,
    `select app.transition_sponsor_asset($1, 'Proposed', 'Submitted', 'Artwork in.')`,
    [asset?.id],
  );
  await expect(
    asPerson(
      PEOPLE.owner,
      `select app.transition_sponsor_asset($1, 'Submitted', 'Approved', 'Mine.')`,
      [asset?.id],
    ),
  ).rejects.toThrow();
  await page.reload();
  const assetRow = page.getByRole("listitem").filter({ hasText: assetTitle });
  await expect(assetRow.getByText("Awaiting your approval")).toBeVisible();
  await expectAccessibleInBothThemes(page);
  const answer = assetRow.getByRole("form", { name: assetTitle });
  await answer.getByRole("button", { name: "Return for changes" }).click();
  await answer.getByLabel("What to change").fill("Use the white logo on the dark screen.");
  await answer.getByRole("button", { name: "Return for changes" }).last().click();
  await expect(assetRow.getByText("Answer sent.")).toBeVisible();
  await asPerson(
    PEOPLE.producer,
    `select app.transition_sponsor_asset($1, 'Returned', 'Submitted', 'White logo version.')`,
    [asset?.id],
  );
  await page.reload();
  await expect(assetRow.getByText("Revision 1")).toBeVisible();
  await assetRow
    .getByRole("form", { name: assetTitle })
    .getByRole("button", { name: "Approve" })
    .last()
    .click();
  await expect(assetRow.getByText("Answer sent.")).toBeVisible();
  await page.reload();
  await expect(assetRow.getByText("Approved", { exact: true })).toBeVisible();
  const [decided] = await sql<{ decided_by: string; asset_state: string }>(
    `select decided_by, asset_state::text from app.sponsor_assets where id = $1`,
    [asset?.id],
  );
  expect(decided).toEqual({ decided_by: ROLE_PEOPLE.sponsor, asset_state: "Approved" });

  // Fulfilled with photo evidence captured at the show (the Compass capture's server half).
  await page.goto(`/work/engagements/${engagement.key}/entitlements`);
  await sql(
    `update app.sponsor_entitlements set fulfilled_at = now() where id = $1`,
    [ent.id],
    PEOPLE.field,
  );
  const photos = `Fulfillment photos ${tag}`;
  await sentDocument(engagement.id, "Proof of Performance", photos);
  await page.reload();
  await expect(page.getByRole("listitem").filter({ hasText: entitlement })).toContainText(
    "Fulfilled",
  );

  // The proof-of-performance report reaches the sponsor.
  await page.goto(`/work/engagements/${engagement.key}/proof-of-performance`);
  await expect(page.getByText(photos)).toBeVisible();
  await expectAccessible(page);

  // Atlas, gate 8: the report is the evidence for G8.SPONSOR_OBLIGATIONS.
  const sponsorEvidence = async () =>
    Number(
      (
        await sql<{ n: string }>(
          `select evidence_count::text as n from app.gate_criteria_status
            where project_id = $1 and criterion_id = 'G8.SPONSOR_OBLIGATIONS'`,
          [DEMO.project],
        )
      )[0]?.n ?? 0,
    );
  const before = await sponsorEvidence();
  await asPerson(
    PEOPLE.producer,
    `insert into app.gate_evidence (project_id, criterion_id, evidence_uri, note, assertion_rank)
     values ($1, 'G8.SPONSOR_OBLIGATIONS', $2, $3, 1)`,
    [DEMO.project, `xos://engagement-documents/${photos}`, `Proof of performance for ${pkg}.`],
  );
  expect(await sponsorEvidence()).toBe(before + 1);
  const atlas = await atlasAs(browser, "producer@example.com");
  await atlas.page.goto(`/${ORG}/p/NWS/gates`);
  await expect(atlas.page.getByText("G8.SPONSOR_OBLIGATIONS").first()).toBeVisible();
  await expectAccessible(atlas.page);
  await atlas.context.close();
});
