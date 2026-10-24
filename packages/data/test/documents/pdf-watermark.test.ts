import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  degrees,
} from "pdf-lib";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { watermarkText } from "../../src/documents/generate.ts";
import {
  PDF_WATERMARK_LIMITS,
  contentBalance,
  displayedPoint,
  stampPdfWatermark,
  visibleBox,
} from "../../src/documents/pdf-watermark.ts";
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
    expect(await stampPdfWatermark(new TextEncoder().encode("not a pdf"), "x")).toMatchObject({
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
  it("knows what closes a page's own content, and errs on the side of closing more", () => {
    const balance = (content: string) => contentBalance(new TextEncoder().encode(content));
    const closed = { saves: 0, restores: 0, openText: false, openPath: false, openMarked: 0 };
    expect(balance("q 1 0 0 1 72 72 cm BT /F1 12 Tf (Hi) Tj ET Q")).toEqual(closed);
    // The reviewer's page: two restores without saves, then a 1% scale and a 1 by 1 clip.
    expect(balance("Q Q 0.01 0 0 0.01 0 0 cm 0 0 1 1 re W n")).toEqual({ ...closed, saves: 2 });
    expect(balance("q 2 0 0 2 0 0 cm")).toEqual({ ...closed, restores: 1 });
    expect(balance("/OC /oc1 BDC 0 0 m 10 10 l")).toEqual({
      ...closed,
      openPath: true,
      openMarked: 1,
    });
    expect(balance("BT /F1 12 Tf")).toEqual({ ...closed, openText: true });
    expect(balance("/Span <</MCID 0>> BDC [(a) 120 (b)] TJ EMC EMC")).toEqual(closed);
    // Operators inside strings, comments and inline image data do not count.
    expect(balance("(Q Q \\) Q) Tj <51> Tj % Q Q\nq")).toEqual({ ...closed, restores: 1 });
    expect(balance("BI /W 2 /H 1 /BPC 8 /CS /G ID QQ EI q")).toEqual({ ...closed, restores: 1 });
    // Content that ends inside a string, an inline image, an array or a hex string swallows what follows.
    for (const open of ["(abc", "BI /W 1 /H 1 ID abc", "[ (a) ", "<414", "<< /A 1"]) {
      expect(balance(open)).toBeNull();
    }
  });

  it("draws the line in the page's initial state even over a page that unbalances it", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const crafted = "Q Q 0.01 0 0 0.01 0 0 cm 0 0 1 1 re W n /OC /hidden BDC 2 0 0 2 0 0 cm q";
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(crafted)));
    const out = await stampPdfWatermark(await doc.save(), "Downloaded by ana@venue.test");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const streams = (await pageContents(out.bytes))[0] ?? [];
    const overlay = streams.findIndex((stream) => stream.includes("/Artifact BMC"));
    expect(overlay).toBeGreaterThan(0);
    expect(streams).toContain(crafted);
    // Everything before the line opens nothing it does not close and restores nothing it did not save.
    const before = contentBalance(new TextEncoder().encode(streams.slice(0, overlay).join("\n")));
    expect(before).toEqual({
      saves: 0,
      restores: 0,
      openText: false,
      openPath: false,
      openMarked: 0,
    });
  });

  it("refuses a page whose content would swallow the line", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("BT (open")));
    expect(await stampPdfWatermark(await doc.save(), "x")).toEqual({
      ok: false,
      reason: "unreadable",
      detail: "page 1 content",
    });
  });

  it("finds the visible area whatever order a box lists its corners in", async () => {
    const page = { x: 0, y: 0, width: 612, height: 792 };
    expect(visibleBox({ x: 612, y: 792, width: -612, height: -792 }, page)).toEqual(page);
    expect(visibleBox(page, { x: 36, y: 36, width: 540, height: 720 })).toEqual({
      x: 36,
      y: 36,
      width: 540,
      height: 720,
    });
    // A crop box beside the page shows the page.
    expect(visibleBox(page, { x: 700, y: 0, width: 100, height: 100 })).toEqual(page);

    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).node.set(PDFName.of("MediaBox"), doc.context.obj([612, 792, 0, 0]));
    const out = await stampPdfWatermark(await doc.save(), "Downloaded by ana@venue.test");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The bottom line starts 10 points in from the lower left, on the page.
    expect((await pageContents(out.bytes))[0]?.join("\n")).toMatch(/1 0 0 1 10 10 Tm/);
  });

  it("drops an XFA form, which a viewer would show instead of the marked pages", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.catalog.set(
      PDFName.of("AcroForm"),
      doc.context.obj({ Fields: [], XFA: doc.context.register(doc.context.stream("<xdp/>")) }),
    );
    doc.catalog.set(PDFName.of("NeedsRendering"), doc.context.obj(true));
    const out = await stampPdfWatermark(await doc.save(), "x");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const stamped = await PDFDocument.load(out.bytes);
    const form = stamped.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
    expect(form?.has(PDFName.of("Fields"))).toBe(true);
    expect(form?.has(PDFName.of("XFA"))).toBe(false);
    expect(stamped.catalog.has(PDFName.of("NeedsRendering"))).toBe(false);
  });

  it("refuses files over the limits on reading an upload, before inflating a bomb", async () => {
    const original = await upload();
    const small = { ...PDF_WATERMARK_LIMITS, bytes: original.length - 1 };
    expect(await stampPdfWatermark(original, "x", small)).toEqual({
      ok: false,
      reason: "too-large",
      detail: "file size",
    });
    expect(
      await stampPdfWatermark(original, "x", { ...PDF_WATERMARK_LIMITS, pages: 2 }),
    ).toMatchObject({ ok: false, reason: "too-large" });

    // An object stream that inflates to 2 MiB, against a 1 MiB budget: refused before pdf-lib reads it.
    const bomb = deflateSync(Buffer.alloc(2 * 1024 * 1024));
    const file = Buffer.concat([
      Buffer.from(
        `%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${bomb.length} >>\nstream\n`,
        "latin1",
      ),
      bomb,
      Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
    ]);
    const budget = { ...PDF_WATERMARK_LIMITS, decodedBytes: 1024 * 1024 };
    expect(await stampPdfWatermark(new Uint8Array(file), "x", budget)).toMatchObject({
      ok: false,
      reason: "too-large",
    });

    // So is a page whose content inflates past it, and a large stream under another filter.
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    page.node.set(
      PDFName.of("Contents"),
      doc.context.register(doc.context.flateStream("q Q ".repeat(300_000))),
    );
    expect(await stampPdfWatermark(await doc.save(), "x", budget)).toMatchObject({
      ok: false,
      reason: "too-large",
    });
    const hexDoc = await PDFDocument.create();
    hexDoc
      .addPage()
      .node.set(
        PDFName.of("Contents"),
        hexDoc.context.register(
          hexDoc.context.stream("71".repeat(40_000), { Filter: "ASCIIHexDecode" }),
        ),
      );
    expect(await stampPdfWatermark(await hexDoc.save(), "x")).toMatchObject({
      ok: false,
      reason: "too-large",
    });
  });
});
