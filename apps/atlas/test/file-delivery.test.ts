import { describe, expect, it } from "vitest";
import { copyForViewer, watermarkKind } from "@/lib/files/deliver";
import { hexText as hex, pdfStreams as streams, twoPagePdf } from "./fixtures/pdf";

/**
 * The copy a viewer receives (Section 8.6, finding A65-016; A103): Confidential and Restricted PDFs
 * and images never leave unmarked, and a file that cannot carry the mark is refused.
 */

/** A 2 by 2 PNG, enough for the renderer to embed. */
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const base = {
  filename: "Rider v2.pdf",
  contentType: "application/pdf",
  viewerEmail: "ana@venue.test",
  orgName: "Northwind Live",
  locale: "en-US" as const,
  sourceUrl: "https://atlas.example.test/files/v1",
  now: new Date("2026-10-19T15:30:00Z"),
};

describe("copies for viewers", () => {
  it("knows which types carry the watermark", () => {
    expect(watermarkKind("application/pdf")).toBe("pdf");
    expect(watermarkKind(" Image/JPEG ")).toBe("image");
    expect(watermarkKind("image/png")).toBe("image");
    expect(watermarkKind("image/webp")).toBeNull();
    expect(watermarkKind("image/heic")).toBeNull();
    expect(watermarkKind("image/gif")).toBeNull();
  });

  it("stamps the viewer and the time on every page of a Confidential PDF", async () => {
    const copy = await copyForViewer({ ...base, bytes: twoPagePdf(), watermark: true });
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    expect(copy.file.filename).toBe("Rider-v2-watermarked.pdf");
    expect(copy.file.contentType).toBe("application/pdf");
    const content = streams(copy.file.bytes);
    const line = hex("Downloaded by ana@venue.test on Oct 19, 2026, 3:30 PM UTC");
    // Two copies of the line on each of the two pages.
    expect(content.split(line).length - 1).toBe(4);
    expect(content).toContain("(rider page 1) tj");
    expect(content).toContain("(rider page 2) tj");
  });

  it("writes the line in the viewer's language", async () => {
    const copy = await copyForViewer({
      ...base,
      locale: "es-US",
      bytes: twoPagePdf(),
      watermark: true,
    });
    expect(copy.ok && streams(copy.file.bytes)).toContain(
      hex("Descargado por ana@venue.test el 19 oct 2026"),
    );
  });

  it("sends a file that needs no watermark as stored", async () => {
    const bytes = twoPagePdf();
    const copy = await copyForViewer({ ...base, bytes, watermark: false });
    expect(copy).toEqual({
      ok: true,
      file: { bytes, filename: "Rider v2.pdf", contentType: "application/pdf" },
    });
  });

  it("refuses an image the watermark cannot carry, and a PDF it cannot rewrite", async () => {
    const webp = await copyForViewer({
      ...base,
      filename: "stage.webp",
      contentType: "image/webp",
      bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
      watermark: true,
    });
    expect(webp).toEqual({ ok: false, reason: "unsupported" });
    const broken = await copyForViewer({
      ...base,
      bytes: new TextEncoder().encode("%PDF-1.4\nnot really"),
      watermark: true,
    });
    expect(broken).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("renders a Confidential PNG as a PDF carrying the line", async () => {
    const copy = await copyForViewer({
      ...base,
      filename: "stage.png",
      contentType: "image/png",
      bytes: PNG,
      watermark: true,
    });
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    expect(copy.file).toMatchObject({
      filename: "stage-watermarked.pdf",
      contentType: "application/pdf",
    });
    expect(Buffer.from(copy.file.bytes).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(Buffer.from(copy.file.bytes).toString("latin1")).toContain(
      "<pdf:Keywords>Downloaded by ana@venue.test on Oct 19, 2026, 3:30 PM UTC</pdf:Keywords>",
    );
  }, 60_000);
});
