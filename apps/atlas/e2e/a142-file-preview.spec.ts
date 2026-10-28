import { expect, test, type Page } from "./engine-test";
import { signIn } from "./a16-support";
import { openDocument, uploadAttachment } from "./attachment-support";
import { expectAccessible, uniqueId } from "./support";
import { twoPagePdf } from "../test/fixtures/pdf";

/**
 * A142 (RRR-205, Section 11.4): file rows open in @xos/ui FilePreviewer. A PDF draws its pages with
 * page buttons and zoom; an image shows as itself. Both are read from /files/{version}, so a
 * Confidential image previews as the watermarked PDF a download would deliver.
 */

/** Server actions on a development server can take seconds on first compile. */
const slow = expect.configure({ timeout: 30_000 });

/** A 2-by-2 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==",
  "base64",
);

/** Opens a file row's preview and answers the drawer. */
async function preview(page: Page, row: ReturnType<Page["locator"]>, title: string) {
  const delivered = page.waitForResponse((r) => /\/files\/[0-9a-f-]{36}$/.test(r.url()));
  await row.getByRole("button", { name: "Preview" }).click();
  const response = await delivered;
  const drawer = page.getByRole("dialog", { name: title });
  await slow(drawer).toBeVisible();
  return { drawer, response };
}

test.describe("file previews", () => {
  test("a PDF and an image preview in the file previewer, and a Confidential image arrives watermarked", async ({
    page,
  }) => {
    // Two uploads, their scans and three previews on a development server.
    test.setTimeout(480_000);
    const id = uniqueId();
    await signIn(page);
    await openDocument(page);

    const pdfName = `rider-${id}.pdf`;
    const pdfRow = await uploadAttachment(
      page,
      { name: pdfName, mimeType: "application/pdf", buffer: Buffer.from(twoPagePdf()) },
      "atlas-e2e-a142",
    );
    const pdf = await preview(page, pdfRow, pdfName);
    expect(pdf.response.status()).toBe(200);
    expect(pdf.response.headers()["content-type"]).toBe("application/pdf");
    await slow(pdf.drawer.getByRole("img", { name: "Page 1 of 2" })).toBeVisible();
    await expect(pdf.drawer.getByText("2 pages")).toBeVisible();
    await pdf.drawer.getByRole("button", { name: "Page 2" }).click();
    await slow(pdf.drawer.getByRole("img", { name: "Page 2 of 2" })).toBeVisible();
    await pdf.drawer.getByRole("button", { name: "Zoom in" }).click();
    await expect(pdf.drawer.getByText("125%")).toBeVisible();
    // The page is drawn: the canvas holds pixels, not an empty frame.
    const drawn = await pdf.drawer.locator('canvas[data-preview="pdf"]').evaluate((c) => {
      const canvas = c as HTMLCanvasElement;
      return canvas.width > 0 && canvas.height > 0;
    });
    expect(drawn).toBe(true);
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(pdf.drawer).toBeHidden();

    const imageName = `stage-${id}.png`;
    const imageRow = await uploadAttachment(
      page,
      { name: imageName, mimeType: "image/png", buffer: PNG },
      "atlas-e2e-a142",
    );
    const image = await preview(page, imageRow, imageName);
    expect(image.response.headers()["content-type"]).toBe("image/png");
    const img = image.drawer.getByRole("img", { name: imageName });
    await slow(img).toBeVisible();
    expect(await img.getAttribute("src")).toMatch(/^blob:/);
    expect(await img.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBe(2);
    await page.keyboard.press("Escape");

    // Classified Confidential, the same image previews as the marked PDF a download delivers.
    await imageRow.getByRole("button", { name: "Share" }).click();
    const panel = page.getByRole("region", { name: `Share ${imageName}` });
    await panel.getByLabel("Classification").selectOption("Confidential");
    await panel.getByRole("button", { name: "Save classification" }).click();
    await slow(panel.getByText("Classification saved.")).toBeVisible();
    await page.reload();
    await page.locator("html[data-shell-ready]").waitFor();
    const classified = page.locator("li", { hasText: imageName }).first();
    const marked = await preview(page, classified, imageName);
    expect(marked.response.status()).toBe(200);
    expect(marked.response.headers()["content-type"]).toBe("application/pdf");
    expect(marked.response.headers()["content-disposition"]).toContain("watermarked");
    await expect(
      marked.drawer.getByText(
        "Confidential and Restricted files preview as they download: with your email and the time on every page.",
      ),
    ).toBeVisible();
    await slow(marked.drawer.getByRole("img", { name: "Page 1 of 1" })).toBeVisible();
    await expect(marked.drawer.locator('img[data-preview="image"]')).toHaveCount(0);
  });
});
