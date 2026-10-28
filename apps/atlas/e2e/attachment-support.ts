import { createClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";
import { ORG } from "./a16-support";

/**
 * Shared steps for the journeys that attach files on the demo tenant and download them (A82 share
 * links in compliance.spec.ts, A103 watermarked PDFs in a103-pdf-watermarks.spec.ts).
 */

/** Server actions on a development server can take seconds on first compile. */
const slow = expect.configure({ timeout: 30_000 });

/** A service-role client on the local stack, which the journeys use in place of the workers. */
export function localStackApp() {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  if (!url || !key)
    throw new Error("Set E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY to the local stack.");
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("Local stack only.");
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Stands in for the upload-scan worker's local pass-through (ADR 0034) on attachment scans. */
export async function passAttachmentScans(worker: string): Promise<void> {
  const app = localStackApp().schema("app");
  const { data, error } = await app.rpc("claim_jobs", {
    p_worker: worker,
    p_job_kind: "attachment.scan",
    p_limit: 50,
  });
  if (error) throw new Error(`claim_jobs: ${error.message}`);
  for (const job of (data as { id: string; subject_id: string }[] | null) ?? []) {
    const scanned = await app.rpc("record_attachment_scan", {
      p_attachment_version_id: job.subject_id,
      p_clean: true,
    });
    if (scanned.error) throw new Error(`record_attachment_scan: ${scanned.error.message}`);
    await app.rpc("finish_job", { p_job_id: job.id, p_succeeded: true, p_error: null });
  }
}

/** Opens the first demo document's full record page, where files attach. */
export async function openDocument(page: Page): Promise<void> {
  await page.goto(`/${ORG}/knowledge/documents?view=list`);
  await page.getByRole("row").nth(1).getByRole("button", { name: "Open" }).click();
  await page.waitForURL(/peek=/);
  const url = new URL(page.url());
  url.searchParams.set("full", "1");
  await page.goto(url.toString());
  await page.locator("html[data-shell-ready]").waitFor();
}

/** Uploads a file to the open record, passes its scan and answers its row in the file list. */
export async function uploadAttachment(
  page: Page,
  file: { readonly name: string; readonly mimeType: string; readonly buffer: Buffer },
  worker: string,
) {
  const files = page.locator("section", {
    has: page.getByRole("heading", { name: "Attachments" }),
  });
  await files.locator('input[type="file"]').setInputFiles(file);
  await files.getByRole("button", { name: "Upload" }).click();
  await slow(files.getByText(file.name).first()).toBeVisible();
  await passAttachmentScans(worker);
  await page.reload();
  await page.locator("html[data-shell-ready]").waitFor();
  return page.locator("li", { hasText: file.name }).first();
}
