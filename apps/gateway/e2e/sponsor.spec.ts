import { expect as baseExpect, test } from "@playwright/test";
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
 * Journey 47 (Section 20.2), sponsor: the sponsor accepts the sponsorship package, approves the
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

  // Assets: the banner artwork is reviewed and approved under separation of duties. Sponsor
  // assets have no Gateway view or submit path yet (finding A38-005), so the review runs through
  // app.transition_sponsor_asset, the call Atlas makes, and the sponsor's Asset approvals tab
  // still shows its empty state.
  const [asset] = await sql<{ id: string }>(
    `insert into app.sponsor_assets (sponsor_entitlement_id, asset_kind, title, due_on)
     values ($1, 'Logo', $2, '2027-05-20') returning id`,
    [ent.id, `Main stage banner artwork ${tag}`],
    PEOPLE.owner,
  );
  await expect(
    asPerson(
      PEOPLE.owner,
      `select app.transition_sponsor_asset($1, 'Proposed', 'Submitted', 'Artwork in.')`,
      [asset?.id],
    ),
  ).resolves.toBeDefined();
  await expect(
    asPerson(
      PEOPLE.owner,
      `select app.transition_sponsor_asset($1, 'Submitted', 'Approved', 'Mine.')`,
      [asset?.id],
    ),
  ).rejects.toThrow();
  await asPerson(
    PEOPLE.producer,
    `select app.transition_sponsor_asset($1, 'Submitted', 'Approved', 'Logo lockup approved.')`,
    [asset?.id],
  );
  await page.goto(`/work/engagements/${engagement.key}/asset-approvals`);
  await expect(page.getByText("Nothing waits for your approval.", { exact: false })).toBeVisible();

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
