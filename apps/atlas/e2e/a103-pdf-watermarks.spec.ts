import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { expect, test, type Browser, type Page } from "./engine-test";
import { ORG, signIn } from "./a16-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * A103 (RRR-148, finding A65-016 part 2): an uploaded Confidential PDF downloads with the viewer's
 * email and the time on every page, from the file row in Atlas and through a share link, which a
 * Confidential PDF may now have (Section 8.6).
 */

/** Server actions on a development server can take seconds on first compile. */
const slow = expect.configure({ timeout: 30_000 });

/** Two letter pages, each drawing its own line. pdf-lib reads the objects, not the offsets. */
function riderPdf(): Buffer {
  const page = (n: number) => `BT /F1 18 Tf 72 700 Td (Rider page ${n}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${page(1).length} >>\nstream\n${page(1)}\nendstream`,
    `<< /Length ${page(2).length} >>\nstream\n${page(2)}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** The content of every stream in a PDF, inflated when compressed, lowercased. */
function pdfStreams(bytes: Buffer): string {
  const out: string[] = [];
  for (const m of bytes.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const raw = Buffer.from(m[1] ?? "", "latin1");
    try {
      out.push(inflateSync(raw).toString("latin1"));
    } catch {
      out.push(raw.toString("latin1"));
    }
  }
  return out.join("\n").toLowerCase();
}

/** Helvetica draws the watermark as a hex string of its character codes. */
const hex = (text: string) =>
  [...text].map((c) => (c.codePointAt(0) ?? 0).toString(16).padStart(2, "0")).join("");

/** How many times the watermark naming `email` is drawn, and the PDF's page count. */
function marks(bytes: Buffer, email: string): { readonly marks: number; readonly pages: number } {
  const content = pdfStreams(bytes);
  return {
    marks: content.split(hex(`Downloaded by ${email} on `)).length - 1,
    pages: (bytes.toString("latin1").match(/\/Type \/Page\b(?!s)/g) ?? []).length,
  };
}

/** Stands in for the upload-scan worker's local pass-through (ADR 0034) on attachment scans. */
async function passAttachmentScans() {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  if (!url || !key)
    throw new Error("Set E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY to the local stack.");
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("Local stack only.");
  const app = createClient(url, key, { auth: { persistSession: false } }).schema("app");
  const { data, error } = await app.rpc("claim_jobs", {
    p_worker: "atlas-e2e-a103",
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
async function openDocument(page: Page) {
  await page.goto(`/${ORG}/knowledge/documents?view=list`);
  await page.getByRole("row").nth(1).getByRole("button", { name: "Open" }).click();
  await page.waitForURL(/peek=/);
  const url = new URL(page.url());
  url.searchParams.set("full", "1");
  await page.goto(url.toString());
  await page.locator("html[data-shell-ready]").waitFor();
}

async function upload(page: Page, name: string, buffer: Buffer) {
  const files = page.locator("section", {
    has: page.getByRole("heading", { name: "Attachments" }),
  });
  await files
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "application/pdf", buffer });
  await files.getByRole("button", { name: "Upload" }).click();
  await slow(files.getByText(name).first()).toBeVisible();
  await passAttachmentScans();
  await page.reload();
  await page.locator("html[data-shell-ready]").waitFor();
  return page.locator("li", { hasText: name }).first();
}

/** A browser context with no session and no Global Privacy Control signal. */
async function visitorPage(browser: Browser) {
  return (await browser.newContext({ extraHTTPHeaders: {} })).newPage();
}

test.describe("watermarked uploaded PDFs", () => {
  test("a Confidential PDF downloads marked on every page, in Atlas and through a share link", async ({
    page,
    browser,
  }) => {
    // An upload, a scan and two downloads on a development server: more than the default minute.
    test.setTimeout(480_000);
    const id = uniqueId();
    const name = `rider-${id}.pdf`;
    await signIn(page);
    await openDocument(page);
    const row = await upload(page, name, riderPdf());

    await row.getByRole("button", { name: "Share" }).click();
    const panel = page.getByRole("region", { name: `Share ${name}` });
    await slow(panel).toBeVisible();
    await panel.getByLabel("Classification").selectOption("Confidential");
    await panel.getByRole("button", { name: "Save classification" }).click();
    await slow(panel.getByText("Classification saved.")).toBeVisible();

    // In Atlas: the file row's download opens /files/{version}, which answers the marked copy.
    await page.evaluate(() => {
      const opened: string[] = [];
      (window as unknown as { __opened: string[] }).__opened = opened;
      window.open = (url?: string | URL) => {
        opened.push(String(url));
        return null;
      };
    });
    await row.getByRole("button", { name: "Download" }).click();
    await slow
      .poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened[0]))
      .toMatch(/\/files\/[0-9a-f-]{36}$/);
    const inApp = await page.request.get(
      await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened[0] ?? ""),
    );
    expect(inApp.status()).toBe(200);
    expect(inApp.headers()["content-disposition"]).toContain(`rider-${id}-watermarked.pdf`);
    expect(marks(Buffer.from(await inApp.body()), "owner@example.com")).toEqual({
      marks: 4,
      pages: 2,
    });

    // A share link: the Confidential PDF is no longer refused, and names its recipient.
    await panel.getByRole("button", { name: "Create link" }).click();
    await slow(
      panel.getByText("Enter the recipient's email. The watermark carries it."),
    ).toBeVisible();
    const recipient = `ana-${id}@venue.test`;
    await panel.getByLabel("Recipient's email").fill(recipient);
    await panel.getByRole("button", { name: "Create link" }).click();
    const codeField = panel.getByRole("textbox", { name: "Access code" });
    await slow(codeField).toHaveValue(/^[0-9]{6}$/);
    const code = await codeField.inputValue();
    const shareUrl = new URL(await panel.getByRole("textbox", { name: "Link" }).inputValue());

    const visitor = await visitorPage(browser);
    await visitor.goto(shareUrl.pathname);
    await slow(visitor.getByRole("heading", { level: 1, name: "Shared file" })).toBeVisible();
    await expect(
      visitor.getByText(
        "Confidential PDFs and images download as a PDF with your email and the time on every page.",
      ),
    ).toBeVisible();
    await expectAccessible(visitor);
    await visitor.getByLabel("Access code").fill(code);
    const download = visitor.waitForEvent("download", { timeout: 120_000 });
    await visitor.getByRole("button", { name: "Open file" }).click({ timeout: 120_000 });
    const file = await download;
    expect(file.suggestedFilename()).toBe(`rider-${id}-watermarked.pdf`);
    const shared = readFileSync((await file.path()) as string);
    expect(shared.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Both pages kept, each with its own text and the line naming the recipient twice.
    const content = pdfStreams(shared);
    expect(content).toContain("(rider page 1) tj");
    expect(content).toContain("(rider page 2) tj");
    expect(marks(shared, recipient)).toEqual({ marks: 4, pages: 2 });
    await visitor.context().close();
  });
});
