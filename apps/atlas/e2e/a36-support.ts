import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { drainImportJobs, supabaseImportStore } from "@xos/data/import-worker";

/**
 * Shared steps of A36's journeys (26, 27, 28, 32, 39 and 57) on the demo tenant (seeds 0010, 1030 and
 * 1060): signing in as a demo person, calling the public API with the page's session cookie, and one
 * pass of the import worker, which runs with the service role in production (an Edge Function on a
 * schedule) and here against the local stack only.
 */

export const DEMO_ORG = "demo-productions";
export const PARTNER_ORG = "demo-partner";
const DEMO_PASSWORD = `xos-demo-${"2026"}`;

export async function signInAs(page: Page, email: string, org: string) {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${org}/home`)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL(`**/${org}/home`);
}

/** A JSON POST to the public API as the signed-in page (session cookie, same-origin Origin header). */
export async function apiPost(
  request: APIRequestContext,
  baseURL: string,
  path: string,
  body: unknown,
) {
  const response = await request.post(`/api/v1${path}`, {
    data: body,
    headers: {
      Origin: baseURL,
      "Idempotency-Key": `a36-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
  expect(response.status(), `${path}: ${await response.text()}`).toBeLessThan(300);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Stands in for the upload-scan worker's local pass-through (ADR 0034) on the import spreadsheets:
 * an import is detected only once its file scans Clean (1240), and no clamd runs in e2e. Only the
 * imports bucket is claimed (app.claim_bucket_scans); other buckets' scans are left alone.
 */
async function passImportScans(client: SupabaseClient) {
  const app = client.schema("app");
  const { data, error } = await app.rpc("claim_bucket_scans", {
    p_bucket_id: "imports",
    p_worker: "atlas-e2e",
    p_limit: 100,
  });
  if (error) throw new Error(`claim_bucket_scans: ${error.message}`);
  for (const scan of (data as { object_scan_id: string }[] | null) ?? []) {
    const verdict = await app.rpc("record_object_scan", {
      p_object_scan_id: scan.object_scan_id,
      p_clean: true,
    });
    if (verdict.error) throw new Error(`record_object_scan: ${verdict.error.message}`);
  }
}

/**
 * Runs the import worker until no import job is left (local stack only). E2E_SUPABASE_URL and
 * E2E_SUPABASE_SERVICE_KEY name the local stack; the key is the local development key that
 * `supabase status` prints, never a hosted project's.
 */
export async function runImportWorker() {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  if (!url || !key)
    throw new Error("Set E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY to the local stack.");
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url))
    throw new Error("The import worker runs here against a local stack only.");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await passImportScans(client);
  const results = await drainImportJobs(supabaseImportStore(client), "atlas-e2e");
  const failed = results.filter((r) => r.status !== "Succeeded");
  expect(failed, JSON.stringify(failed)).toEqual([]);
  return results;
}

/** Reloads until a locator shows, for work the import worker finished in the background. */
export async function reloadUntil(page: Page, target: Locator, tries = 10) {
  for (let i = 0; i < tries; i += 1) {
    const shown = await target
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "TimeoutError") return false;
        throw error;
      });
    if (shown) return;
    await page.reload();
  }
  await expect(target).toBeVisible();
}
