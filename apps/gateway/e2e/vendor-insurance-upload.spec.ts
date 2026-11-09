import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import { demoVendorId, requirements, suffix, vendorEngagement } from "./role-fixtures";
import { expectAccessible, signIn, sql } from "./support";

/**
 * A vendor's insurance upload, from Gateway to Atlas (launch flag, 2026-11-06). The vendor is pointed at Compliance, where
 * it is; after uploading it sees the file was received and waits for review, not "none on file"; whoever records
 * certificates sees the upload on Insurance certificates once it is scanned, and a passed review keeps it there, because
 * passing records no certificate, with the vendor told so. Recording it verifies nothing, and the vendor then sees the
 * certificate.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const POLICY = () => `GL-UP-${suffix()}`;

test("a vendor's upload is received, waits for review and becomes a certificate", async ({
  page,
  browser,
}) => {
  const vendor = await demoVendorId();
  // The state under test is a vendor with no certificate: the seed's and earlier runs' go aside, and come back after.
  const aside = await sql<{ id: string }>(
    `update app.insurance_certificates set deleted_at = now() where vendor_id = $1 and deleted_at is null returning id`,
    [vendor],
  );
  const name = `Certificate of Insurance ${suffix()}`;
  const packet = await requirements("Vendor", [{ name, kind: "Document Upload" }]);
  try {
    const engagement = await vendorEngagement();
    await signIn(page, "vendor@example.com", `/work/engagements/${engagement.key}/compliance`);

    // Before: the copy points where the vendor is, never at an Onboarding tab it does not have.
    const none = "No insurance certificate on file. When the organization asks for one";
    await expect(page.getByText(none)).toBeVisible();
    await expect(page.getByText("Upload one under Onboarding")).toHaveCount(0);
    await expectAccessible(page);

    // The upload.
    const form = page.getByRole("form", { name });
    await form.getByLabel("File or photo").setInputFiles({
      name: "coi.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
    });
    await form.getByRole("button", { name: "Upload" }).click();

    // After: received and waiting, and it stays that way across a reload.
    const waiting = `${name}: received and waiting for review.`;
    await expect(page.getByText(waiting)).toBeVisible();
    await page.reload();
    await expect(page.getByText(waiting)).toBeVisible();
    await expect(page.getByText(none)).toHaveCount(0);
    await expect(page.getByText("No insurance certificate recorded yet.")).toBeVisible();

    // Atlas: until the scanner clears the file it can be seen and not recorded.
    const atlas = await atlasAs(browser, "producer@example.com");
    await atlas.page.goto(`/${ORG}/vendors/insurance-certificates`);
    const uploads = atlas.page.getByRole("region", { name: "Vendor uploads with no certificate" });
    const row = uploads.getByRole("listitem").filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByText("Waiting for review")).toBeVisible();
    await expect(row.getByRole("link", { name: "Record certificate" })).toHaveCount(0);
    await expectAccessible(atlas.page);

    const file = await sql<{ name: string }>(
      `select substr(dv.storage_uri, char_length('storage://onboarding-uploads/') + 1) as name
         from app.onboarding_items i
         join app.onboarding_requirements r on r.id = i.onboarding_requirement_id
         join app.document_versions dv on dv.document_id = i.document_id
        where i.engagement_id = $1 and r.name = $2`,
      [engagement.id, name],
    );
    await sql(
      `select app.record_object_scan(s.id, true)::text from private.object_scans s
        where s.bucket_id = 'onboarding-uploads' and s.object_name = $1 and s.scan_status = 'Scanning'`,
      [file[0]?.name],
    );

    // Passing the review records no certificate: it stays listed here and the vendor is told, never "none on file" again.
    await sql(
      `insert into app.onboarding_verifications (org_id, onboarding_item_id, outcome, note)
       select i.org_id, i.id, 'Passed', 'Checked.' from app.onboarding_items i
         join app.onboarding_requirements r on r.id = i.onboarding_requirement_id
        where i.engagement_id = $1 and r.name = $2`,
      [engagement.id, name],
    );
    await atlas.page.reload();
    await expect(row.getByText("Passed review, no certificate recorded")).toBeVisible();
    await page.reload();
    await expect(page.getByText(`${name}: reviewed and passed.`)).toBeVisible();
    await expect(page.getByText(none)).toHaveCount(0);

    // Recording it verifies nothing more.
    await row.getByRole("link", { name: "Record certificate" }).click();

    const policy = POLICY();
    const drawer = atlas.page.getByRole("dialog");
    await expect(drawer.getByText(`: ${name}.`)).toBeVisible();
    const today = new Date().toISOString().slice(0, 10);
    const nextYear = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
    await drawer.getByLabel("Insurer", { exact: true }).fill("Atlantic Mutual");
    await drawer.getByLabel("Policy number", { exact: true }).fill(policy);
    await drawer.getByLabel("Coverage", { exact: true }).fill("General Liability");
    await drawer.getByLabel("Valid from", { exact: true }).fill(today);
    await drawer.getByLabel("Valid to", { exact: true }).fill(nextYear);
    await drawer.getByRole("button", { name: "Record certificate" }).click();

    await expect(atlas.page.getByText("Atlantic Mutual").first()).toBeVisible();
    await expect(row).toHaveCount(0);
    const [state] = await sql<{ document_uri: string; verifications: string }>(
      `select c.document_uri,
         (select count(*)::text from app.onboarding_verifications ov
           join app.onboarding_items i on i.id = ov.onboarding_item_id
           where i.engagement_id = $2) as verifications
       from app.insurance_certificates c where c.policy_identifier = $1`,
      [policy, engagement.id],
    );
    expect(state?.document_uri).toMatch(/^storage:\/\/onboarding-uploads\//);
    // The one review above, and nothing from recording.
    expect(state?.verifications).toBe("1");
    await atlas.context.close();

    // Gateway: the certificate is on file now.
    await page.reload();
    const coi = page.getByRole("listitem").filter({ hasText: policy });
    await expect(coi).toBeVisible();
    await expect(coi.getByText("Current")).toBeVisible();
    await expect(page.getByText(`${name}: reviewed and passed.`)).toHaveCount(0);
  } finally {
    await packet.retire();
    await sql(`update app.insurance_certificates set deleted_at = null where id = any($1)`, [
      aside.map((c) => c.id),
    ]);
  }
});
