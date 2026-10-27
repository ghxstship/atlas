import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect as baseExpect, test, type Page } from "@playwright/test";
import {
  DEFAULT_EXPORT_COPY,
  runExportRenders,
  supabaseExportFiles,
  supabaseExportRenderStore,
} from "@xos/data/export-renders";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";
import { enrollAuthenticator } from "./totp";

/**
 * A102 (RRR-146; Section 4.6.4, Section 8.6): export from every collection. A new Owner exports the venues list
 * as CSV from the view switcher's Export menu; one pass of the export worker (the same code the export-render
 * Edge Function runs, here with the service role of the local stack) writes the file, and the page downloads it
 * with the list's columns and the venue. Then the Owner exports the rate card lines, whose rate is Restricted: the
 * export asks for a second factor first (the Owner has none, so the dialog sets one up), then goes ahead, and the
 * downloaded file carries the rate the Owner may read. The database records that export as Restricted and
 * watermarked.
 *
 * Two steps reach the local stack directly, as journey 29 does: seeding the venue and the rate card, and the
 * worker pass. E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY name the local stack only.
 */
test.use({ reducedMotion: "reduce", actionTimeout: 60_000 });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 60_000 });

function localStack(): SupabaseClient {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  if (!url || !key) throw new Error("Set E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY.");
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) {
    throw new Error("The export journey runs against a local stack only.");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** One worker pass after the export was queued: runs the worker until it has rendered one export. */
async function renderQueuedExport(client: SupabaseClient): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const outcome = await runExportRenders({
      store: supabaseExportRenderStore(client),
      files: supabaseExportFiles(client),
      copy: () => DEFAULT_EXPORT_COPY,
      worker: "atlas-e2e-a102",
    });
    if (outcome.renders.length > 0) {
      expect(
        outcome.renders.map((r) => r.status),
        JSON.stringify(outcome.renders),
      ).toEqual(["Ready"]);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("No export was queued.");
}

/** Opens the Export menu of the view switcher and picks a format. */
async function exportAs(page: Page, format: "CSV" | "Excel (.xlsx)" | "PDF") {
  const control = page.locator('[data-shortcut="view.export"]');
  await expect(control).toHaveCount(1);
  await control.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: format, exact: true }).click();
}

test("export a list as CSV, and a Restricted column only after step-up", async ({ page }) => {
  const client = localStack();
  const id = uniqueId();
  const slug = `export-${id}`;
  await signUp(page, { name: "Esme Export", email: testEmail("export", id) });
  await createOrganization(page, { name: `Export Works ${id}`, slug });

  const app = client.schema("app");
  const { data: org } = await app.from("organizations").select("id").eq("slug", slug).single();
  const orgId = (org as { id: string } | null)?.id ?? "";
  expect(orgId).not.toBe("");
  const venue = await app.from("venues").insert({
    org_id: orgId,
    name: `Harborfront Hall ${id}`,
    locality: "Key West",
    jurisdiction_id: "US-FL-MIAMI-DADE",
    time_zone: "America/New_York",
  });
  expect(venue.error).toBeNull();
  const card = await app
    .from("rate_cards")
    .insert({
      org_id: orgId,
      name: "2027 Crew Rates",
      currency_code: "USD",
      effective_from: "2027-01-01",
    })
    .select("id")
    .single();
  expect(card.error).toBeNull();
  const line = await app.from("rate_card_lines").insert({
    rate_card_id: (card.data as { id: string }).id,
    role_code: "0000.50.01",
    worker_classification: "INDEPENDENT_CONTRACTOR",
    pay_basis: "Day Rate",
    arrangement: "Retainer",
    canon_rate_card_id: "LRC-001",
    overtime_rule_id: "OTR-002",
    rate_minor: 85000,
  });
  expect(line.error).toBeNull();

  // An Internal list: the venues table, exported as CSV with its columns.
  await page.goto(`/${slug}/places/venues?view=table`);
  await expect(page.getByText(`Harborfront Hall ${id}`).first()).toBeVisible();
  await expectAccessible(page);
  await exportAs(page, "CSV");
  await expect(
    page.getByText("Preparing your export. It downloads when it is ready."),
  ).toBeVisible();
  const venues = page.waitForEvent("download");
  await renderQueuedExport(client);
  const venuesFile = await venues;
  expect(venuesFile.suggestedFilename()).toMatch(/\.csv$/);
  const csv = readFileSync(await venuesFile.path(), "utf8");
  expect(csv.split("\n")[0]).toBe("Name,Jurisdiction,Time zone,Street address,City,Postal code");
  expect(csv).toContain(`Harborfront Hall ${id},US-FL-MIAMI-DADE,America/New_York,,Key West,`);
  await expect(page.getByText("Your export is ready: 1 row.")).toBeVisible();

  // A Restricted column: the rate of a rate card line asks for a second factor before the export starts.
  await page.goto(`/${slug}/crew/rate-cards?view=table`);
  await exportAs(page, "CSV");
  const setUp = page.getByRole("dialog", { name: "Set up a second factor" });
  await expect(setUp).toBeVisible();
  await expectAccessible(page);
  const before = await app.from("export_jobs").select("id").eq("org_id", orgId);
  expect(before.data).toHaveLength(1);
  await enrollAuthenticator(setUp);
  await expect(setUp).toBeHidden();
  await expect(
    page.getByText("Preparing your export. It downloads when it is ready."),
  ).toBeVisible();
  const rates = page.waitForEvent("download");
  await renderQueuedExport(client);
  const ratesFile = await rates;
  const rateCsv = readFileSync(await ratesFile.path(), "utf8");
  expect(rateCsv.split("\n")[0]).toBe(
    "Role,Classification,Pay basis,Arrangement,Overtime rule,Rate (minor units)",
  );
  expect(rateCsv).toContain("0000.50.01,INDEPENDENT_CONTRACTOR,Day Rate,Retainer,OTR-002,85000");

  const restricted = await app
    .from("export_jobs")
    .select("classification, watermark, export_status")
    .eq("org_id", orgId)
    .eq("classification", "Restricted");
  expect(restricted.data).toEqual([
    { classification: "Restricted", watermark: true, export_status: "Ready" },
  ]);
  const logged = await app
    .from("file_access_log")
    .select("bucket_id, action")
    .eq("org_id", orgId)
    .eq("bucket_id", "export-files");
  expect(logged.data).toHaveLength(2);
});
