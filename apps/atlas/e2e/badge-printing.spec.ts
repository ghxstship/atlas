import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "./a79-support";
import { expect as baseExpect, settle, test, type Page } from "./engine-test";
import { expectAccessibleInBothThemes, ORG, signIn } from "./operations-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * P5 (RRR-219, G-144) on the demo tenant: a credential record shows its badge photo state; a badge downloads
 * on a CR80 card; the Issued credentials print panel downloads the checked badges in one PDF and leaves an
 * unchecked one out; and "Request photo" notifies the holder with the Gateway link. Credentials are seeded with
 * the service role under a fresh category per run, and a Clean photo stands in for the upload-scan worker's
 * local pass-through (ADR 0034), as a36-support.ts does for imports. Every surface is checked with axe in both
 * themes and at phone width.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const ORG_ID = "01920000-0000-7000-8000-000000000001";
const FIELD_LEAD = "01920000-0000-7000-8000-000000000104";
const CREW = "01920000-0000-7000-8000-000000000201";
const PROJECT = "NWS";
/** A 1 by 1 PNG: the badge embeds it as the holder's photo. */
const PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function projectId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client
    .schema("app")
    .from("projects")
    .select("id")
    .eq("org_id", ORG_ID)
    .eq("project_key", PROJECT)
    .single();
  if (error) throw new Error(`project ${PROJECT}: ${error.message}`);
  return (data as { id: string }).id;
}

/** A fresh category on the project with one live credential per holder; earlier runs' badge photos are cleared. */
async function seedCredentials(
  client: SupabaseClient,
  holders: readonly string[],
): Promise<{ categoryId: string; credentials: { id: string; number: string }[] }> {
  const app = client.schema("app");
  const id = uniqueId().slice(-6).toUpperCase();
  const category = await app
    .from("credential_categories")
    .insert({ project_id: await projectId(client), code: `P5-${id}`, name: `Badge run ${id}` })
    .select("id")
    .single();
  if (category.error) throw new Error(`category: ${category.error.message}`);
  const categoryId = (category.data as { id: string }).id;
  const cleared = await app
    .from("credential_photos")
    .update({ deleted_at: new Date().toISOString() })
    .eq("org_id", ORG_ID)
    .in("person_id", [...new Set(holders)])
    .is("deleted_at", null);
  if (cleared.error) throw new Error(`clear photos: ${cleared.error.message}`);
  const inserted = await app
    .from("credentials")
    .insert(
      holders.map((holder) => ({
        credential_category_id: categoryId,
        holder_person_id: holder,
        valid_to: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      })),
    )
    .select("id, credential_number");
  if (inserted.error) throw new Error(`credentials: ${inserted.error.message}`);
  return {
    categoryId,
    credentials: (inserted.data as { id: string; credential_number: string }[]).map((c) => ({
      id: c.id,
      number: c.credential_number,
    })),
  };
}

/** A Clean badge photo of the holder with their consent, as the holder's upload and the scan worker leave it. */
async function seedCleanPhoto(client: SupabaseClient, holder: string): Promise<void> {
  const app = client.schema("app");
  const path = `${ORG_ID}/${holder}/${randomUUID()}.png`;
  const uploaded = await client.storage
    .from("credential-photos")
    .upload(path, PHOTO, { contentType: "image/png", upsert: false });
  if (uploaded.error) throw new Error(`upload: ${uploaded.error.message}`);
  const claimed = await app.rpc("claim_bucket_scans", {
    p_bucket_id: "credential-photos",
    p_worker: "atlas-e2e-p5",
    p_limit: 100,
  });
  if (claimed.error) throw new Error(`claim_bucket_scans: ${claimed.error.message}`);
  for (const scan of (claimed.data as { object_scan_id: string }[] | null) ?? []) {
    const verdict = await app.rpc("record_object_scan", {
      p_object_scan_id: scan.object_scan_id,
      p_clean: true,
    });
    if (verdict.error) throw new Error(`record_object_scan: ${verdict.error.message}`);
  }
  const consent = await app
    .from("consent_records")
    .insert({
      org_id: ORG_ID,
      person_id: holder,
      purpose_code: "credential_photo",
      notice_version: "credential-photo-2026-11",
      source: "Web",
    })
    .select("id")
    .single();
  if (consent.error) throw new Error(`consent: ${consent.error.message}`);
  const photo = await app.from("credential_photos").insert({
    org_id: ORG_ID,
    person_id: holder,
    photo_path: path,
    source: "Holder Upload",
    provided_at: new Date().toISOString(),
    provided_by: holder,
    consent_record_id: (consent.data as { id: string }).id,
  });
  if (photo.error) throw new Error(`photo: ${photo.error.message}`);
}

async function atPhoneWidth(page: Page): Promise<void> {
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await settle(page);
  await expectAccessible(page);
  if (size) await page.setViewportSize(size);
}

test.describe("Printable photo badges (P5)", () => {
  test("the record shows the photo state and downloads a CR80 badge with the photo", async ({
    page,
  }) => {
    const client = serviceClient();
    const { credentials } = await seedCredentials(client, [FIELD_LEAD]);
    const [credential] = credentials;
    if (!credential) throw new Error("no credential seeded");
    await seedCleanPhoto(client, FIELD_LEAD);
    await signIn(page, "producer@example.com");

    await page.goto(`/${ORG}/credentials/issued?project=${PROJECT}&peek=${credential.id}`);
    const peek = page.getByRole("dialog");
    const photo = peek.getByRole("region", { name: "Badge photo" });
    await expect(photo).toBeVisible();
    await expect(photo.getByText("Provided", { exact: true })).toBeVisible();
    await expect(photo.getByRole("img", { name: "Badge photo of Demo Field Lead" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await atPhoneWidth(page);

    const href = `/${ORG}/documents/credential-badge/${credential.id}?paper=cr80`;
    const response = await page.request.get(href);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/pdf");
    expect(response.headers()["x-document-template-version"]).toBe("2");
    const pdf = (await response.body()).toString("latin1");
    expect(pdf).toContain("/MediaBox [0 0 153.01 242.65]");
    expect(pdf).toContain("/Alt (Photo of Demo Field Lead, the credential holder)");

    const badge = page.getByRole("dialog").getByRole("region", { name: "Badge" });
    await badge.getByLabel("Paper size").selectOption({ label: "CR80 card" });
    const download = page.waitForEvent("download");
    await badge.getByRole("button", { name: "Download PDF" }).click();
    expect((await download).suggestedFilename()).toBe(
      `credential-badge-${credential.number}-cr80.pdf`,
    );
  });

  test("the print panel downloads the checked badges in one PDF", async ({ page }) => {
    const client = serviceClient();
    const { categoryId, credentials } = await seedCredentials(client, [
      FIELD_LEAD,
      CREW,
      FIELD_LEAD,
    ]);
    await signIn(page, "producer@example.com");
    await page.goto(`/${ORG}/credentials/issued?project=${PROJECT}&category=${categoryId}`);
    await page.getByRole("link", { name: "Print badges" }).click();
    const panel = page.getByRole("region", { name: "Print badges" });
    await expect(panel).toBeVisible();
    for (const c of credentials)
      await expect(panel.getByRole("checkbox", { name: new RegExp(c.number) })).toBeChecked();
    await expectAccessibleInBothThemes(page);
    await atPhoneWidth(page);

    const all = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Download badges PDF" }).click();
    expect((await all).suggestedFilename()).toBe("credential-badges-3-cr80.pdf");

    await page.goto(`/${ORG}/credentials/issued?project=${PROJECT}&category=${categoryId}&print=1`);
    const again = page.getByRole("region", { name: "Print badges" });
    await again
      .getByRole("checkbox", { name: new RegExp(credentials[1]?.number ?? "-") })
      .uncheck();
    await again.getByLabel("Size").selectOption({ label: "US Letter" });
    const some = page.waitForEvent("download");
    await again.getByRole("button", { name: "Download badges PDF" }).click();
    expect((await some).suggestedFilename()).toBe("credential-badges-2-letter.pdf");

    const ids = credentials.map((c) => `id=${c.id}`).join("&");
    const batch = await page.request.get(`/${ORG}/documents/badges?${ids}&paper=cr80`);
    expect(batch.status()).toBe(200);
    expect(batch.headers()["x-badges-skipped"]).toBe("0");
    const pdf = (await batch.body()).toString("latin1");
    expect((pdf.match(/\/S \/Sect\b/g) ?? []).length).toBe(3);
    const many = Array.from({ length: 101 }, () => `id=${credentials[0]?.id}`).join("&");
    expect((await page.request.get(`/${ORG}/documents/badges?${many}`)).status()).toBe(400);
  });

  test("Request photo notifies the holder with the Gateway link, once a day", async ({ page }) => {
    const client = serviceClient();
    const { credentials } = await seedCredentials(client, [CREW]);
    const [credential] = credentials;
    if (!credential) throw new Error("no credential seeded");
    await signIn(page, "producer@example.com");
    await page.goto(`/${ORG}/credentials/issued?project=${PROJECT}&peek=${credential.id}`);
    const photo = page.getByRole("dialog").getByRole("region", { name: "Badge photo" });
    await photo.getByRole("button", { name: "Request photo" }).click();
    await expect(photo.getByRole("status")).toHaveText("1 holder asked.");
    const { data, error } = await client
      .schema("app")
      .from("notifications")
      .select("message_args")
      .eq("kind", "credential_photo.requested")
      .eq("subject_id", credential.id);
    expect(error).toBeNull();
    expect(
      (data as { message_args: Record<string, string> }[]).map(
        (n) => n.message_args["gatewayPath"],
      ),
    ).toEqual(["/profile/badge-photos"]);
    await page.reload();
    await settle(page);
    const reread = page.getByRole("dialog").getByRole("region", { name: "Badge photo" });
    await expect(reread.getByText("Requested", { exact: true })).toBeVisible();
    await reread.getByRole("button", { name: "Request photo" }).click();
    await expect(reread.getByRole("status")).toHaveText("1 already asked in the last 24 hours.");
  });
});
