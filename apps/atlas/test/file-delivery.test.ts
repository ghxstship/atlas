import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { copyForViewer, watermarkKind } from "@/lib/files/deliver";

/**
 * The copy a viewer receives (Section 8.6, finding A65-016; A103): Confidential and Restricted PDFs
 * and images never leave unmarked, and a file that cannot carry the mark is refused.
 */

/** Two letter pages, each drawing its own line; the offsets need not be exact for pdf-lib. */
function twoPagePdf(): Uint8Array {
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
  return new TextEncoder().encode(body);
}

/** Every stream of a PDF, inflated when it is compressed. */
function streams(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  for (const m of text.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const raw = Buffer.from(m[1] ?? "", "latin1");
    try {
      out.push(inflateSync(raw).toString("latin1"));
    } catch {
      out.push(raw.toString("latin1"));
    }
  }
  return out.join("\n");
}

const hex = (text: string) =>
  [...text].map((c) => (c.codePointAt(0) ?? 0).toString(16).padStart(2, "0")).join("");

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
    const content = streams(copy.file.bytes).toLowerCase();
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
    expect(copy.ok && streams(copy.file.bytes).toLowerCase()).toContain(
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
    expect(broken).toEqual({ ok: false, reason: "unreadable" });
  });
});
