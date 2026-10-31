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

/** A one-pixel PNG, enough for party-uploads to take as a logo. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/**
 * Journey 47 extended (R9, migration 2713): the sponsor supplies its own logo for an entitlement in
 * Gateway, the org returns it with what to change, the sponsor resubmits it with a new file at the
 * next revision, and the org approves it. The org's two decisions run as the Producer through
 * app.transition_sponsor_asset, as Atlas makes them; the sponsor never approves its own asset.
 */
test("journey 47: the sponsor supplies a logo, the org returns it, the sponsor resubmits, the org approves", async ({
  page,
}) => {
  const engagement = await roleEngagement({
    person: ROLE_PEOPLE.sponsor,
    account: ROLE_ACCOUNTS.sponsor,
    roleType: "Sponsor",
  });
  // Assets are supplied while the engagement's operational area is open.
  await transition("engagement", engagement.id, "Onboarding", "Active", "Package accepted.");
  const tag = suffix();
  const entitlement = `Logo on the LED wall ${tag}`;
  await sponsorEntitlement(entitlement);
  const title = `Brightwave logo ${tag}`;

  await signIn(page, "sponsor@example.com", `/work/engagements/${engagement.key}/asset-approvals`);
  await expect(page.getByRole("heading", { name: "Assets you supply" })).toBeVisible();
  const supply = page.getByRole("form", { name: "Supply an asset" });
  await supply.getByLabel("Entitlement", { exact: true }).selectOption({ label: entitlement });
  await supply.getByLabel("Kind", { exact: true }).selectOption({ label: "Logo" });
  await supply.getByLabel("What it is", { exact: true }).fill(title);
  await supply
    .getByLabel("Files", { exact: true })
    .setInputFiles({ name: "logo-dark.png", mimeType: "image/png", buffer: PIXEL });
  await expectAccessible(page);
  await supply.getByRole("button", { name: "Send for approval" }).click();
  await expect(page.getByText("Sent. The organization reviews it.")).toBeVisible();

  await page.reload();
  const supplied = page.getByRole("list", { name: "Assets you supply" });
  const row = supplied.getByRole("listitem").filter({ hasText: title });
  await expect(row.getByText("Files: logo-dark.png")).toBeVisible();
  const [asset] = await sql<{ id: string; asset_source: string }>(
    "select id, asset_source::text from app.sponsor_assets where title = $1 and deleted_at is null",
    [title],
  );
  expect(asset?.asset_source).toBe("Sponsor Supplied");
  // The sponsor's own approval path is closed to it: the org approves what the sponsor supplies.
  await expect(
    asPerson(
      ROLE_PEOPLE.sponsor,
      "select app.respond_sponsor_asset($1, 'Submitted', 'Approved', null)",
      [asset?.id],
    ),
  ).rejects.toThrow(/sponsor_asset_source/);

  // The org returns it; the sponsor resubmits a white version.
  await asPerson(
    PEOPLE.producer,
    `select app.transition_sponsor_asset($1, 'Submitted', 'Returned', 'Use the white logo on the dark wall.')`,
    [asset?.id],
  );
  await page.reload();
  await expect(row.getByText("Returned", { exact: true })).toBeVisible();
  const resubmit = row.getByRole("form", { name: title });
  await resubmit
    .getByLabel("Files", { exact: true })
    .setInputFiles({ name: "logo-white.png", mimeType: "image/png", buffer: PIXEL });
  await expectAccessibleInBothThemes(page);
  await resubmit.getByRole("button", { name: "Resubmit with new files" }).click();
  await expect(
    page.getByText("Resubmitted. The organization reviews the new revision."),
  ).toBeVisible();
  await page.reload();
  await expect(row.getByText("Revision 1")).toBeVisible();
  await expect(row.getByText("Files: logo-white.png")).toBeVisible();

  // The org approves the new revision.
  await asPerson(
    PEOPLE.producer,
    `select app.transition_sponsor_asset($1, 'Submitted', 'Approved', 'White version works.')`,
    [asset?.id],
  );
  await page.reload();
  await expect(row.getByText("Approved", { exact: true })).toBeVisible();
  const [decided] = await sql<{ decided_by: string; asset_state: string }>(
    "select decided_by, asset_state::text from app.sponsor_assets where id = $1",
    [asset?.id],
  );
  expect(decided).toEqual({ decided_by: PEOPLE.producer, asset_state: "Approved" });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
