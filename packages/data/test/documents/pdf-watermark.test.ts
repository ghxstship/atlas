import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  degrees,
} from "pdf-lib";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { watermarkText } from "../../src/documents/generate.ts";
import { displayedPoint, stampPdfWatermark } from "../../src/documents/pdf-watermark.ts";
import { NOW } from "./fixtures.ts";

/**
 * Uploaded PDFs carry the Section 8.6 watermark (A103, finding A65-016): the viewer's email and the
 * time on every page, over the pages as they were.
 */
const catalog = (locale: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../i18n/messages/${locale}/documents.json`, import.meta.url),
      "utf8",
    ),
  );

/** Helvetica draws text as a hex string of its WinAnsi codes; ASCII and Latin-1 map one to one. */
const hex = (text: string) =>
  `<${[...text].map((c) => (c.codePointAt(0) ?? 0).toString(16).padStart(2, "0")).join("")}>`.toUpperCase();

/** Three pages: letter, A4 landscape, and a letter page shown turned a quarter clockwise. */
async function upload(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const sizes: [number, number][] = [
    [612, 792],
    [842, 595],
    [612, 792],
  ];
  sizes.forEach(([w, h], i) => {
    const page = doc.addPage([w, h]);
    page.drawText(`Original page ${i + 1}`, { x: 72, y: h - 96, size: 24, font });
  });
  doc.getPage(2).setRotation(degrees(90));
  return doc.save();
}

/** Each page's content streams, decoded. */
async function pageContents(bytes: Uint8Array): Promise<string[][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() : [];
    return refs.map((ref) => {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) return "";
      return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
    });
  });
}

const EN = catalog("en-US");
const ES = catalog("es-US");

describe("uploaded PDF watermark", () => {
  it("stamps the viewer and the time on every page and keeps the pages as they were", async () => {
    const original = await upload();
    const before = await pageContents(original);
    const text = watermarkText(EN, "en-US", "ana@venue.test", NOW);
    const out = await stampPdfWatermark(original, text);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.pages).toBe(3);

    const doc = await PDFDocument.load(out.bytes);
    expect(doc.getPages().map((p) => [p.getWidth(), p.getHeight(), p.getRotation().angle])).toEqual(
      [
        [612, 792, 0],
        [842, 595, 0],
        [612, 792, 90],
      ],
    );
    const after = await pageContents(out.bytes);
    const marked = hex("Downloaded by ana@venue.test on Oct 19, 2026, 3:30 PM UTC");
    after.forEach((streams, i) => {
      const all = streams.join("\n");
      // The page's own content is still there, word for word, inside a saved graphics state.
      for (const own of before[i] ?? []) expect(streams).toContain(own);
      expect(all).toContain(hex(`Original page ${i + 1}`));
      expect(streams[0]?.trim()).toBe("q");
      // The line twice, the diagonal light and the bottom line readable, both as artifacts.
      expect(all.split(marked).length - 1).toBe(2);
      expect(all).toMatch(/\/Artifact BMC[\s\S]*Tj[\s\S]*Tj[\s\S]*EMC/);
    });
    // The quarter-turned page draws its text turned with it (cos 122 degrees, sin 122 degrees).
    expect(after[2]?.join("\n")).toMatch(
      /-0\.5299\d* 0\.848\d* -0\.848\d* -0\.5299\d* [\d.]+ [\d.]+ Tm/,
    );
  });

  it("draws the Spanish line with its accents and folds characters Helvetica lacks", async () => {
    const original = await upload();
    const es = await stampPdfWatermark(original, "Descargado por josé@venue.test el 19 oct 2026");
    const folded = await stampPdfWatermark(original, "Downloaded by łukasz@venue.test now");
    expect(es.ok && folded.ok).toBe(true);
    if (!es.ok || !folded.ok) return;
    expect((await pageContents(es.bytes))[0]?.join("\n")).toContain(
      hex("Descargado por josé@venue.test el 19 oct 2026"),
    );
    // Ł is not in WinAnsi: it falls back to "l" through NFKD or "?"; the narrow space becomes a space.
    expect((await pageContents(folded.bytes))[0]?.join("\n")).toMatch(
      new RegExp(
        `${hex("Downloaded by ").slice(0, -1)}(6C|3F)${hex("ukasz@venue.test now").slice(1)}`,
      ),
    );
    expect(watermarkText(ES, "es-US", "ana@venue.test", NOW)).toMatch(/^Descargado por/);
  });

  it("refuses an encrypted PDF rather than sending it unmarked", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.context.trailerInfo.Encrypt = doc.context.register(
      doc.context.obj({ Filter: "Standard", V: 2, R: 3 }),
    );
    expect(await stampPdfWatermark(await doc.save(), "x")).toEqual({
      ok: false,
      reason: "encrypted",
    });
  });

  it("refuses a file that is not a PDF", async () => {
    expect(await stampPdfWatermark(new TextEncoder().encode("not a pdf"), "x")).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("places points on the page as it is displayed, whatever its /Rotate", () => {
    const box = { x: 10, y: 20, width: 600, height: 800 };
    expect(displayedPoint(box, 0, 5, 7)).toEqual({ x: 15, y: 27 });
    // Turned a quarter clockwise, the lower left shown is the page's lower right.
    expect(displayedPoint(box, 90, 0, 0)).toEqual({ x: 610, y: 20 });
    expect(displayedPoint(box, 180, 0, 0)).toEqual({ x: 610, y: 820 });
    expect(displayedPoint(box, 270, 0, 0)).toEqual({ x: 10, y: 820 });
  });
});
