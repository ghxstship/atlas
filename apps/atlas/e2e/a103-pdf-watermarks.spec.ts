import { readFileSync } from "node:fs";
import { expect, test, type Browser } from "./engine-test";
import { signIn } from "./a16-support";
import { localStackApp, openDocument, uploadAttachment } from "./attachment-support";
import { expectAccessible, uniqueId } from "./support";
import { pdfStreams, twoPagePdf, watermarks } from "../test/fixtures/pdf";

/**
 * A103 (RRR-148, finding A65-016 part 2): an uploaded Confidential PDF downloads with the viewer's
 * email and the time on every page, from the file row in Atlas and through a share link, which a
 * Confidential PDF may now have (Section 8.6). The recipient who skips Atlas and trades the link's
 * ticket at the file-download function directly gets nothing (1691).
 */

/** Server actions on a development server can take seconds on first compile. */
const slow = expect.configure({ timeout: 30_000 });

/** How many times the watermark naming `email` is drawn, and the PDF's page count. */
const marks = (bytes: Buffer, email: string) => watermarks(bytes, `Downloaded by ${email} on `);

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
    const row = await uploadAttachment(
      page,
      { name, mimeType: "application/pdf", buffer: Buffer.from(twoPagePdf()) },
      "atlas-e2e-a103",
    );

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

    // The recipient who calls the open RPC and the file-download function directly, with the token
    // and the code but without the handover secret only Atlas holds, gets nothing.
    const token = shareUrl.pathname.split("/").pop() ?? "";
    const direct = await localStackApp()
      .schema("api_public")
      .rpc("open_share_link", { p_token: token, p_access_code: code });
    expect(direct.error).toBeNull();
    const ticket = (direct.data as { ticket: string | null; watermark: boolean }[])[0];
    expect(ticket?.watermark).toBe(true);
    expect(ticket?.ticket).toMatch(/^xdlt_[0-9a-f]{64}$/);
    for (const authorization of [undefined, `Bearer ${"0".repeat(64)}`]) {
      const answer = await page.request.post(
        `${process.env["E2E_SUPABASE_URL"]}/functions/v1/file-download`,
        {
          headers: authorization ? { Authorization: authorization } : {},
          data: { ticket: ticket?.ticket },
        },
      );
      expect(answer.status()).toBe(404);
    }
  });
});
