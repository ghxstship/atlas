import type { DocumentBlock, DocumentColumn, DocumentModel, Paper, PrintSize } from "./model.ts";
import {
  DOCUMENT_CLASSIFICATION,
  isCardPaper,
  MAX_BATCH,
  MAX_BOOK_DOCUMENTS,
  needsWatermark,
} from "./model.ts";
import { qrMatrix } from "./qr.ts";

/** Page orientation: portrait by default; wide forms such as the WH-347 and OSHA 300 print landscape. */
export type Orientation = "portrait" | "landscape";

/**
 * Renders a document model to tagged PDF/UA-1 with pdfkit 0.20.2 (ADR 0031): a structure tree in
 * reading order, the document language and title, embedded Inter fonts, alternative text on the
 * logo and the QR code, real table headers with a scope, and page furniture marked as artifacts.
 * Server only: pdfkit loads on first use and never reaches a browser bundle.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- pdfkit's types omit the tagging internals used here. */
export type Doc = any;
export type StructElement = any;

const MARGIN = 54;
const FOOTER = 28;
const GAP = 10;
const BODY = 9.5;
const SMALL = 8;
export const TEXT = "black";
export const MUTED = "dimgray";
export const RULE = "silver";
const QR_SIZE = 72;
/** The badge portrait and gate code on Letter and A4 (P5). */
const PORTRAIT_WIDTH = 90;
const PORTRAIT_HEIGHT = 112;
const SCAN_SIZE = 108;

/**
 * Page sizes in points. A6 is pdfkit's 297.64 by 419.53; CR80 is the ID-1 card, 53.98 by 85.60 mm, portrait
 * (P5). The card sizes are for the credential badge only (printSizesFor).
 */
export const SIZES: Record<PrintSize, string | [number, number]> = {
  letter: "LETTER",
  a4: "A4",
  a6: "A6",
  cr80: [153.01, 242.65],
};

export { MAX_BATCH };

/** Book page numbering of one document (B7): its first page's place in the book and the book's page count. */
export interface BookPagination {
  readonly offset: number;
  readonly total: number;
}

/** The fixed width of a contents entry's page column, so a page number never changes a line break. */
const CONTENTS_PAGE_WIDTH = 40;

let fontCache: { regular: Buffer; semibold: Buffer } | null = null;

export async function fonts(): Promise<{ regular: Buffer; semibold: Buffer }> {
  if (!fontCache) {
    const { INTER_REGULAR_HEX, INTER_SEMIBOLD_HEX } = await import("./fonts.generated.ts");
    const [regular, semibold] = await Promise.all([
      sfntFromWoff(Buffer.from(INTER_REGULAR_HEX, "hex")),
      sfntFromWoff(Buffer.from(INTER_SEMIBOLD_HEX, "hex")),
    ]);
    fontCache = { regular, semibold };
  }
  return fontCache;
}

/**
 * The TrueType font a WOFF file wraps (WOFF 1.0: the same tables, each compressed with zlib).
 * fontkit inflates a WOFF table in JavaScript every time it reads it, once for each glyph it
 * measures or embeds, which was most of the time a document took to render. The tables are
 * inflated once here, natively, and the cached font is read as it is. The PDF does not change.
 */
export async function sfntFromWoff(woff: Uint8Array): Promise<Buffer> {
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  const count = view.getUint16(12);
  const tables = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const entry = 44 + i * 20;
      const offset = view.getUint32(entry + 4);
      const stored = view.getUint32(entry + 8);
      const length = view.getUint32(entry + 12);
      const data = woff.subarray(offset, offset + stored);
      return {
        tag: view.getUint32(entry),
        checksum: view.getUint32(entry + 16),
        data: stored < length ? await inflate(data) : data,
      };
    }),
  );
  const padded = (n: number) => (n + 3) & ~3;
  const out = Buffer.alloc(tables.reduce((n, t) => n + padded(t.data.length), 12 + 16 * count));
  const selector = Math.floor(Math.log2(count));
  out.writeUInt32BE(view.getUint32(4), 0);
  out.writeUInt16BE(count, 4);
  out.writeUInt16BE(16 * 2 ** selector, 6);
  out.writeUInt16BE(selector, 8);
  out.writeUInt16BE(16 * (count - 2 ** selector), 10);
  let offset = 12 + 16 * count;
  tables.forEach((t, i) => {
    out.writeUInt32BE(t.tag, 12 + 16 * i);
    out.writeUInt32BE(t.checksum, 16 + 16 * i);
    out.writeUInt32BE(offset, 20 + 16 * i);
    out.writeUInt32BE(t.data.length, 24 + 16 * i);
    out.set(t.data, offset);
    offset += padded(t.data.length);
  });
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Text escaped for an XML text node, for the XMP metadata packet. */
export function xmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** The PNG or JPEG signature, the only image formats pdfkit embeds. */
export function isEmbeddableImage(bytes: Uint8Array): boolean {
  const png = [0x89, 0x50, 0x4e, 0x47];
  const jpeg = [0xff, 0xd8, 0xff];
  return (
    png.every((b, i) => bytes[i] === b) ||
    (bytes.length > 3 && jpeg.every((b, i) => bytes[i] === b))
  );
}

/**
 * Text the embedded font can draw. A character Inter's Latin subset lacks would draw the .notdef
 * glyph, which PDF/UA forbids, so it falls back to its base letter (NFKD) or a question mark.
 * Control characters other than line breaks are dropped.
 */
export function printable(text: string, has: (codePoint: number) => boolean): string {
  let out = "";
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\n") out += ch;
    else if (ch === "\t") out += " ";
    else if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    else if (has(cp)) out += ch;
    else {
      const base = [...ch.normalize("NFKD")].filter((c) => has(c.codePointAt(0) ?? 0)).join("");
      out += base.length > 0 ? base : "?";
    }
  }
  return out;
}

interface PdfSetup {
  readonly paper: PrintSize;
  readonly orientation: Orientation;
  readonly margins: { top: number; left: number; right: number; bottom: number };
  readonly lang: string;
  readonly title: string;
  readonly author: string;
  readonly subject: string;
  readonly keywords?: string;
  readonly createdAt: string;
}

/**
 * A tagged PDF/UA-1 document with the embedded fonts registered (ADR 0031). Pages stay buffered until the caller
 * flushes them, so footers can be drawn once a document's page count is known.
 */
async function openPdf(setup: PdfSetup): Promise<Doc> {
  const [{ default: PDFDocument }, font] = await Promise.all([import("pdfkit"), fonts()]);
  // pdfkit's types lag the library: they omit the PDF/UA subset and a font given as bytes.
  const pdfOptions: Record<string, unknown> = {
    size: SIZES[setup.paper],
    layout: setup.orientation,
    margins: setup.margins,
    pdfVersion: "1.7",
    subset: "PDF/UA",
    tagged: true,
    lang: setup.lang,
    displayTitle: true,
    bufferPages: true,
    font: font.regular,
    info: {
      Title: setup.title,
      Author: setup.author,
      Subject: setup.subject,
      ...(setup.keywords ? { Keywords: setup.keywords } : {}),
      Creator: "XOS",
      Producer: "XOS",
      CreationDate: new Date(setup.createdAt),
    },
  };
  const doc: Doc = new PDFDocument(pdfOptions as never);
  // pdfkit writes a CIDSet for any subset numbered 1, meant for PDF/A-1, so PDF/UA (also part 1)
  // gets one too. Its CIDSet lists only the glyphs drawn, not the composite glyph parts fontkit adds
  // to the subset, which veraPDF refuses (7.21.4.2-2). The CIDSet is optional in PDF/UA, so the part
  // number is held as text: the XMP still says pdfuaid:part 1 and no CIDSet is written.
  doc.subset = "1";
  // pdfkit 0.20.2 writes the title, author and subject into the XMP packet without XML escaping, so a name
  // holding "&" or "<" (a legal entity such as "R&D Rentals LLC") breaks the metadata and with it PDF/UA
  // (dc:title, the pdfuaid schema). The Info dictionary is written before the XMP and keeps the plain text;
  // only the XMP gets the escaped text (A79).
  const addInfo = doc._addInfo.bind(doc);
  doc._addInfo = () => {
    const plain = { ...doc.info };
    for (const key of ["Title", "Author", "Subject", "Creator", "Producer"]) {
      if (typeof doc.info[key] === "string") doc.info[key] = xmlText(doc.info[key]);
    }
    try {
      addInfo();
    } finally {
      doc.info = plain;
    }
  };
  doc.registerFont("regular", font.regular);
  doc.registerFont("semibold", font.semibold);
  return doc;
}

/** Every chunk pdfkit writes, joined once the document ends. */
function collect(doc: Doc): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => {
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      resolve(out);
    });
  });
}

/** Page margins: cards keep a narrow edge and print no footer; Letter and A4 leave room for the footer. */
function marginsFor(paper: PrintSize) {
  if (paper === "cr80") return { top: 8, left: 8, right: 8, bottom: 8 };
  if (paper === "a6") return { top: 18, left: 18, right: 18, bottom: 18 };
  return { top: MARGIN, left: MARGIN, right: MARGIN, bottom: MARGIN + FOOTER };
}

/** Card papers print only the credential badge; the routes check isPrintSizeFor first. */
function assertPrintable(model: DocumentModel, paper: PrintSize): void {
  if (isCardPaper(paper) && model.kind !== "credential-badge") {
    throw new Error(`A ${model.kind} prints on Letter or A4, not ${paper}.`);
  }
}

/** Draws one model under a parent structure element, starting on the current page. */
async function drawModel(
  doc: Doc,
  parent: StructElement,
  model: DocumentModel,
  paper: PrintSize,
  pagination?: BookPagination,
): Promise<void> {
  if (isCardPaper(paper)) {
    const { CardRenderer } = await import("./render-card.ts");
    new CardRenderer(doc, model, parent, paper).render();
  } else {
    new Renderer(doc, model, parent, pagination).render();
  }
}

/**
 * Draws documents one after another under the Document root: each a Sect starting on a new page, its pages
 * written out as soon as it is drawn (P5). With bookmarks, each also gets an outline item; with pagination, its
 * footers number the whole book (B7). Returns each document's page count.
 */
async function writeSections(
  doc: Doc,
  root: StructElement,
  models: readonly DocumentModel[],
  paper: PrintSize,
  options: {
    readonly bookmarks?: boolean;
    readonly pagination?: readonly BookPagination[];
  } = {},
): Promise<number[]> {
  const counts: number[] = [];
  for (const [i, model] of models.entries()) {
    if (i > 0) doc.addPage();
    const before = doc.bufferedPageRange();
    const first = before.start + before.count - 1;
    if (options.bookmarks) doc.outline.addItem(model.title);
    const section = doc.struct("Sect");
    root.add(section);
    await drawModel(doc, section, model, paper, options.pagination?.[i]);
    section.end();
    const after = doc.bufferedPageRange();
    counts.push(after.start + after.count - first);
    doc.flushPages();
  }
  return counts;
}

export async function renderDocumentPdf(
  model: DocumentModel,
  options: { readonly paper: PrintSize; readonly orientation?: Orientation },
): Promise<Uint8Array> {
  assertPrintable(model, options.paper);
  const doc = await openPdf({
    paper: options.paper,
    orientation: options.orientation ?? "portrait",
    margins: marginsFor(options.paper),
    lang: model.lang,
    title: model.title,
    author: model.brand.legalEntity ?? model.brand.name,
    subject: `${model.facts.recordKey} v${model.facts.templateVersion}`,
    ...(model.watermark ? { keywords: model.watermark.text } : {}),
    createdAt: model.facts.generatedAtIso,
  });
  const done = collect(doc);
  try {
    const root = doc.struct("Document");
    doc.addStructure(root);
    await drawModel(doc, root, model, options.paper);
    root.end();
    doc.end();
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  return done;
}

export interface BatchOptions {
  readonly paper: PrintSize;
  /** The PDF title, for example "Credential badges (24)". */
  readonly title: string;
  /** The shared language of every model. */
  readonly lang: string;
}

/**
 * Several documents in one tagged PDF/UA-1 file (P5 batch printing): one Document structure root, each document a
 * Sect starting on a new page, with its own header, facts and page numbers. Each document's pages are written out
 * as soon as it is drawn, so the stream never holds the whole batch (a 100-badge run with photos is tens of MB).
 */
export function streamDocumentsPdf(
  models: readonly DocumentModel[],
  options: BatchOptions,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      try {
        if (models.length < 1 || models.length > MAX_BATCH) {
          throw new Error(`A batch holds 1 to ${MAX_BATCH} documents.`);
        }
        for (const model of models) assertPrintable(model, options.paper);
        const first = models[0] as DocumentModel;
        const doc = await openPdf({
          paper: options.paper,
          orientation: "portrait",
          margins: marginsFor(options.paper),
          lang: options.lang,
          title: options.title,
          author: first.brand.legalEntity ?? first.brand.name,
          subject: options.title,
          createdAt: first.facts.generatedAtIso,
        });
        doc.on("data", (chunk: Uint8Array) => controller.enqueue(new Uint8Array(chunk)));
        doc.on("error", (error: unknown) => controller.error(error));
        const ended = new Promise<void>((resolve) => doc.on("end", resolve));
        const root = doc.struct("Document");
        doc.addStructure(root);
        await writeSections(doc, root, models, options.paper);
        root.end();
        doc.end();
        await ended;
        controller.close();
      } catch (error) {
        controller.error(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

export interface BookOptions {
  /** Books print on Letter and A4 only. */
  readonly paper: Paper;
  /** The PDF title: the book's name. */
  readonly title: string;
  /** The shared language of the cover and every document. */
  readonly lang: string;
}

/** The cover with each contents entry's page set; entries follow the documents in order. */
function withPages(cover: DocumentModel, pages: readonly number[]): DocumentModel {
  let next = 0;
  return {
    ...cover,
    blocks: cover.blocks.map((block) =>
      block.kind === "contents"
        ? { ...block, entries: block.entries.map((e) => ({ ...e, page: pages[next++] ?? 0 })) }
        : block,
    ),
  };
}

function bookSetup(cover: DocumentModel, options: BookOptions): PdfSetup {
  return {
    paper: options.paper,
    orientation: "portrait",
    margins: marginsFor(options.paper),
    lang: options.lang,
    title: options.title,
    author: cover.brand.legalEntity ?? cover.brand.name,
    subject: `${cover.facts.recordKey} v${cover.facts.templateVersion}`,
    createdAt: cover.facts.generatedAtIso,
  };
}

/** A book's page plan: each part's page count (the cover first), the book page each starts on, and the total. */
export interface BookLayout {
  readonly counts: readonly number[];
  readonly starts: readonly number[];
  readonly total: number;
}

/**
 * Pass 1 of a book (B7): draws the cover, its contents with placeholder page numbers, and every document into a
 * counting PDF that is thrown away, and returns where each part starts. The page column is fixed-width, so the real
 * numbers drawn in pass 2 cannot move a line.
 */
export async function bookLayout(
  cover: DocumentModel,
  sections: readonly DocumentModel[],
  options: BookOptions,
): Promise<BookLayout> {
  assertBook(cover, sections, options.paper);
  const counting = await openPdf(bookSetup(cover, options));
  counting.on("data", () => undefined);
  const counted = new Promise<void>((resolve, reject) => {
    counting.on("end", resolve);
    counting.on("error", reject);
  });
  const root = counting.struct("Document");
  counting.addStructure(root);
  const counts = await writeSections(counting, root, [cover, ...sections], options.paper);
  root.end();
  counting.end();
  await counted;
  const starts: number[] = [];
  let page = 1;
  for (const count of counts) {
    starts.push(page);
    page += count;
  }
  return { counts, starts, total: page - 1 };
}

function assertBook(cover: DocumentModel, sections: readonly DocumentModel[], paper: string): void {
  if (paper !== "letter" && paper !== "a4")
    throw new Error(`A book prints on Letter or A4, not ${paper}.`);
  if (sections.length < 1 || sections.length > MAX_BOOK_DOCUMENTS) {
    throw new Error(`A book holds 1 to ${MAX_BOOK_DOCUMENTS} documents and its cover.`);
  }
  for (const model of [cover, ...sections]) {
    // Every book section kind prints only Internal columns today; a Confidential or Restricted one would need the
    // viewer watermark on its pages, which a compiled book does not carry (ADR 0146 decision 4).
    if (needsWatermark(DOCUMENT_CLASSIFICATION[model.kind]) || model.watermark) {
      throw new Error(`A book cannot hold a ${model.kind}: it needs the viewer watermark.`);
    }
  }
}

/**
 * A book (B7, ADR 0146 decision 4): the cover with its contents, then each document, in one tagged PDF/UA-1 file.
 * Pass 1 draws everything, the contents with placeholder page numbers, into a counting PDF that is thrown away, to
 * learn each document's page count; the page column is fixed-width, so the real numbers cannot move a line. Pass 2
 * streams one Document root, the cover Sect with the TOC, then a Sect per document on a new page, each with an
 * outline item and footers that number the whole book ("Page n of N").
 */
export function streamBookPdf(
  cover: DocumentModel,
  sections: readonly DocumentModel[],
  options: BookOptions,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      try {
        // Pass 1: count the pages.
        const { counts, starts, total } = await bookLayout(cover, sections, options);
        const pagination = starts.map((offset) => ({ offset, total }));

        // Pass 2: stream the book.
        const doc = await openPdf(bookSetup(cover, options));
        doc.on("data", (chunk: Uint8Array) => controller.enqueue(new Uint8Array(chunk)));
        doc.on("error", (error: unknown) => controller.error(error));
        const ended = new Promise<void>((resolve) => doc.on("end", resolve));
        const root = doc.struct("Document");
        doc.addStructure(root);
        const drawn = await writeSections(
          doc,
          root,
          [withPages(cover, starts.slice(1)), ...sections],
          options.paper,
          {
            bookmarks: true,
            pagination,
          },
        );
        if (drawn.some((count, i) => count !== counts[i])) {
          throw new Error("A book's page count changed between its two passes.");
        }
        root.end();
        doc.end();
        await ended;
        controller.close();
      } catch (error) {
        controller.error(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

/** A book as one buffer, for tests and the veraPDF check. */
export async function renderBookPdf(
  cover: DocumentModel,
  sections: readonly DocumentModel[],
  options: BookOptions,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(streamBookPdf(cover, sections, options)).arrayBuffer());
}

/** The batch PDF as one buffer, for tests and the veraPDF check. */
export async function renderDocumentsPdf(
  models: readonly DocumentModel[],
  options: BatchOptions,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(streamDocumentsPdf(models, options)).arrayBuffer());
}

/**
 * Drawing shared by the page and card layouts: text the embedded font can draw, tagged text elements, artifacts,
 * and the two Figures every badge carries, the portrait and the scan code (P5).
 */
export class TaggedWriter {
  protected readonly root: StructElement;
  private readonly glyphs = new Map<number, boolean>();
  protected readonly doc: Doc;
  protected readonly model: DocumentModel;
  /** The index of the page this model starts on, so its footers number its own pages in a batch. */
  protected readonly firstPage: number;

  constructor(doc: Doc, model: DocumentModel, parent: StructElement) {
    this.doc = doc;
    this.model = model;
    this.root = parent;
    const range = doc.bufferedPageRange();
    this.firstPage = range.start + range.count - 1;
  }

  protected get left(): number {
    return this.doc.page.margins.left;
  }

  protected get width(): number {
    return this.doc.page.width - this.doc.page.margins.left - this.doc.page.margins.right;
  }

  protected get bottom(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  /** Text safe to draw with the embedded font. */
  protected safe(text: string): string {
    const font = this.doc._font?.font;
    return printable(text, (cp) => {
      let known = this.glyphs.get(cp);
      if (known === undefined) {
        known = font ? Boolean(font.hasGlyphForCodePoint(cp)) : cp < 0x7f;
        this.glyphs.set(cp, known);
      }
      return known;
    });
  }

  protected style(weight: "regular" | "semibold", size: number, color = TEXT): void {
    this.doc.font(weight).fontSize(size).fillColor(color);
  }

  /** One tagged text element (P, H1, H2, Caption) added to a parent. */
  protected text(
    parent: StructElement,
    type: string,
    text: string,
    opts: { x?: number; y?: number; width?: number; align?: string } = {},
  ): void {
    const value = this.safe(text) || " ";
    const x = opts.x ?? this.left;
    const width = opts.width ?? this.width;
    const y = opts.y ?? this.doc.y;
    parent.add(
      this.doc.struct(type, () => {
        this.doc.text(value, x, y, { width, align: opts.align ?? "left" });
      }),
    );
  }

  protected artifact(draw: () => void, type: "Layout" | "Pagination" = "Layout"): void {
    this.doc.markContent("Artifact", { type });
    draw();
    this.doc.endMarkedContent();
  }

  /** A QR code as vector squares inside a tagged Figure; the space around it is the quiet zone. */
  protected qr(payload: string, x: number, y: number, size: number, alt: string): void {
    const { doc } = this;
    const matrix = qrMatrix(payload);
    const cell = size / matrix.length;
    this.root.add(
      doc.struct("Figure", { alt: this.safe(alt) }, () => {
        doc.save();
        matrix.forEach((row, r) =>
          row.forEach((dark, c) => {
            if (dark) doc.rect(x + c * cell, y + r * cell, cell, cell);
          }),
        );
        doc.fillColor(TEXT).fill();
        doc.restore();
      }),
    );
  }

  /**
   * The holder's portrait in a fixed frame: the image fitted and centered, never cropped, as a Figure with its
   * alternative text. A missing photo, or one pdfkit cannot embed, draws a ruled frame as an artifact and the
   * placeholder text inside it.
   */
  protected portrait(
    block: Extract<DocumentBlock, { kind: "portrait" }>,
    x: number,
    y: number,
    width: number,
    height: number,
    placeholderSize: number,
  ): void {
    const { doc } = this;
    if (block.bytes && isEmbeddableImage(block.bytes)) {
      const buffer = Buffer.from(block.bytes);
      let opened: { width: number; height: number } | null;
      try {
        opened = doc.openImage(buffer) as { width: number; height: number };
      } catch {
        // A file with an image signature that pdfkit cannot read prints the placeholder.
        opened = null;
      }
      if (opened && opened.width > 0 && opened.height > 0) {
        const scale = Math.min(width / opened.width, height / opened.height);
        const w = opened.width * scale;
        const h = opened.height * scale;
        this.root.add(
          doc.struct("Figure", { alt: this.safe(block.alt) }, () => {
            doc.image(buffer, x + (width - w) / 2, y + (height - h) / 2, { width: w, height: h });
          }),
        );
        return;
      }
    }
    this.artifact(() => {
      doc.rect(x, y, width, height).lineWidth(0.6).strokeColor(RULE).stroke();
    });
    this.style("regular", placeholderSize, MUTED);
    const pad = Math.max(3, width * 0.08);
    const textHeight = doc.heightOfString(this.safe(block.placeholder), { width: width - pad * 2 });
    this.text(this.root, "P", block.placeholder, {
      x: x + pad,
      y: y + Math.max(pad, (height - textHeight) / 2),
      width: width - pad * 2,
      align: "center",
    });
  }
}

class Renderer extends TaggedWriter {
  private readonly pagination: BookPagination | undefined;

  constructor(doc: Doc, model: DocumentModel, parent: StructElement, pagination?: BookPagination) {
    super(doc, model, parent);
    this.pagination = pagination;
  }

  private ensure(height: number): void {
    if (this.doc.y + height > this.bottom) {
      this.doc.addPage();
      this.doc.x = this.left;
      this.doc.y = this.doc.page.margins.top;
    }
  }

  render(): void {
    this.header();
    for (const block of this.model.blocks) this.block(block);
    this.footers();
  }

  private header(): void {
    const { doc, model } = this;
    const top = doc.page.margins.top;
    const factsWidth = 196;
    const textWidth = this.width - QR_SIZE - factsWidth - GAP * 2;

    // Brand: the logo as a Figure with alternative text, or the brand name as text.
    let y = top;
    const logo = model.brand.logo;
    if (logo && isEmbeddableImage(logo.bytes)) {
      const figure = doc.struct("Figure", { alt: this.safe(logo.alt) }, () => {
        doc.image(Buffer.from(logo.bytes), this.left, y, { fit: [140, 36] });
      });
      this.root.add(figure);
      y += 42;
    } else {
      this.style("semibold", 11);
      this.text(this.root, "P", model.brand.name, { y, width: textWidth });
      y = doc.y + 2;
    }
    if (model.brand.legalEntity && model.brand.legalEntity !== model.brand.name) {
      this.style("regular", SMALL, MUTED);
      this.text(this.root, "P", model.brand.legalEntity, { y, width: textWidth });
      y = doc.y;
    }
    this.style("semibold", 18);
    this.text(this.root, "H1", model.title, { y: y + 6, width: textWidth });
    const titleBottom = doc.y;

    // Facts: record key, template version and generation time, then the QR code.
    const factsX = this.left + this.width - QR_SIZE - GAP - factsWidth;
    const facts = model.facts;
    const factsTable = doc.struct("Table");
    this.root.add(factsTable);
    let fy = top;
    for (const [label, value] of [
      [facts.labels.recordKey, facts.recordKey],
      [facts.labels.version, String(facts.templateVersion)],
      [facts.labels.generatedAt, facts.generatedAt],
    ] as const) {
      const row = doc.struct("TR");
      factsTable.add(row);
      this.style("regular", SMALL, MUTED);
      const th = doc.struct("TH", { scope: "Row" } as never);
      row.add(th);
      th.add(
        doc.struct("Span", () => {
          doc.text(this.safe(label), factsX, fy, { width: 80 });
        }),
      );
      th.end();
      const labelBottom = doc.y;
      this.style("semibold", SMALL);
      const td = doc.struct("TD");
      row.add(td);
      const valueText = this.safe(value);
      td.add(
        doc.struct("Span", () => {
          doc.text(valueText, factsX + 84, fy, { width: factsWidth - 84 });
        }),
      );
      td.end();
      row.end();
      fy = Math.max(fy + 12, doc.y + 2, labelBottom + 2);
    }
    factsTable.end();
    this.style("regular", 6.5, MUTED);
    this.text(this.root, "P", facts.recordUrl, { x: factsX, y: fy + 2, width: factsWidth });
    if (model.watermark) {
      // Section 8.6: who received this copy and when, in the reading order; every page repeats it as an artifact.
      this.style("semibold", 6.5, MUTED);
      this.text(this.root, "P", model.watermark.text, {
        x: factsX,
        y: doc.y + 2,
        width: factsWidth,
      });
    }
    const factsBottom = doc.y;

    this.qr(facts.recordUrl, this.left + this.width - QR_SIZE, top, QR_SIZE, facts.labels.qrAlt);

    const headerBottom = Math.max(titleBottom, factsBottom, top + QR_SIZE) + GAP;
    const accent = /^#[0-9a-f]{6}$/i.test(model.brand.accentHex ?? "")
      ? (model.brand.accentHex as string)
      : TEXT;
    this.artifact(() => {
      doc
        .moveTo(this.left, headerBottom)
        .lineTo(this.left + this.width, headerBottom)
        .lineWidth(1.5)
        .strokeColor(accent)
        .stroke();
    });
    doc.x = this.left;
    doc.y = headerBottom + GAP * 1.5;
  }

  private block(block: DocumentBlock): void {
    const { doc } = this;
    switch (block.kind) {
      case "heading": {
        this.style("semibold", 12);
        this.ensure(doc.heightOfString(this.safe(block.text), { width: this.width }) + 24);
        doc.y += 4;
        this.text(this.root, "H2", block.text);
        doc.y += 4;
        return;
      }
      case "image": {
        this.image(block.bytes, block.alt);
        return;
      }
      case "portrait": {
        this.ensure(PORTRAIT_HEIGHT + GAP);
        const y = doc.y;
        this.portrait(block, this.left, y, PORTRAIT_WIDTH, PORTRAIT_HEIGHT, SMALL);
        doc.x = this.left;
        doc.y = y + PORTRAIT_HEIGHT + GAP;
        return;
      }
      case "scan-code": {
        this.style("regular", SMALL, MUTED);
        const captionHeight = doc.heightOfString(this.safe(block.caption), { width: this.width });
        this.ensure(SCAN_SIZE + captionHeight + GAP * 2);
        const y = doc.y;
        this.qr(block.payload, this.left, y, SCAN_SIZE, block.alt);
        this.style("regular", SMALL, MUTED);
        this.text(this.root, "P", block.caption, { y: y + SCAN_SIZE + 4 });
        doc.x = this.left;
        doc.y += GAP;
        return;
      }
      case "paragraph": {
        const size = block.size === "large" ? 22 : BODY;
        this.style(block.size === "large" ? "semibold" : "regular", size);
        for (const part of block.text.split(/\n{2,}/)) {
          const text = this.safe(part.trim());
          if (!text) continue;
          this.ensure(Math.min(doc.heightOfString(text, { width: this.width }), 60) + 4);
          this.text(this.root, "P", text);
          doc.y += size * 0.5;
        }
        return;
      }
      case "fields": {
        this.table(
          block.caption,
          [
            { label: "", weight: 1 },
            { label: "", weight: 2 },
          ],
          block.fields.map((f) => [f.label, f.value]),
          [],
          true,
        );
        return;
      }
      case "contents": {
        this.contents(block);
        return;
      }
      case "table": {
        if (block.rows.length === 0) {
          this.style("semibold", 10);
          this.ensure(40);
          this.text(this.root, "P", block.caption);
          this.style("regular", BODY, MUTED);
          this.text(this.root, "P", block.empty);
          doc.y += GAP;
          return;
        }
        this.table(block.caption, block.columns, block.rows, block.footer ?? [], false);
        return;
      }
    }
  }

  /**
   * A book's contents (B7) as a TOC with one TOCI per entry, each a P holding the title and record key and the page
   * number in a fixed-width column at the end of its first line; dot leaders between them are artifacts.
   */
  private contents(block: Extract<DocumentBlock, { kind: "contents" }>): void {
    const { doc } = this;
    this.style("semibold", 12);
    this.ensure(48);
    doc.y += 4;
    this.text(this.root, "H2", block.caption);
    doc.y += 4;
    if (block.entries.length === 0) {
      this.style("regular", BODY, MUTED);
      this.text(this.root, "P", block.empty);
      doc.y += GAP;
      return;
    }
    const toc = doc.struct("TOC");
    this.root.add(toc);
    const textWidth = this.width - CONTENTS_PAGE_WIDTH - GAP;
    const pageX = this.left + this.width - CONTENTS_PAGE_WIDTH;
    for (const entry of block.entries) {
      this.style("regular", BODY);
      const label = this.safe(`${entry.title}  ${entry.recordKey}`) || " ";
      const height = doc.heightOfString(label, { width: textWidth });
      this.ensure(height + 4);
      const y = doc.y;
      const item = doc.struct("TOCI");
      toc.add(item);
      item.add(
        doc.struct("P", () => {
          doc.text(label, this.left, y, { width: textWidth });
          doc.text(String(entry.page), pageX, y, {
            width: CONTENTS_PAGE_WIDTH,
            align: "right",
            lineBreak: false,
          });
        }),
      );
      item.end();
      const firstLine = doc.widthOfString(label);
      if (firstLine < textWidth - 8) {
        this.artifact(() => {
          const lineY = y + BODY * 0.95;
          doc
            .moveTo(this.left + firstLine + 4, lineY)
            .lineTo(pageX - 4, lineY)
            .lineWidth(0.6)
            .dash(0.6, { space: 2.4 })
            .strokeColor(RULE)
            .stroke()
            .undash();
        });
      }
      doc.x = this.left;
      doc.y = y + height + 4;
    }
    toc.end();
    doc.y += GAP;
  }

  /** A PNG or JPEG fitted to the page width and the space left, as a Figure with alternative text. */
  private image(bytes: Uint8Array, alt: string): void {
    const { doc } = this;
    if (!isEmbeddableImage(bytes)) return;
    const buffer = Buffer.from(bytes);
    const opened = doc.openImage(buffer) as { width: number; height: number };
    const room = () => this.bottom - doc.y;
    const fullPage = this.bottom - doc.page.margins.top;
    const scale = Math.min(1, this.width / opened.width, fullPage / opened.height);
    const height = opened.height * scale;
    if (height > room()) {
      doc.addPage();
      doc.x = this.left;
      doc.y = doc.page.margins.top;
    }
    const width = opened.width * scale;
    const x = this.left + (this.width - width) / 2;
    const y = doc.y;
    this.root.add(
      doc.struct("Figure", { alt: this.safe(alt) }, () => {
        doc.image(buffer, x, y, { width, height });
      }),
    );
    doc.x = this.left;
    doc.y = y + height + GAP;
  }

  /**
   * A table with a caption, a header row of TH cells scoped to their column (or, for fields, a TH
   * per row scoped to the row), body rows and footer rows. A header row repeated on a new page is
   * an artifact, so a screen reader reads the header once.
   */
  private table(
    caption: string,
    columns: readonly DocumentColumn[],
    rows: readonly (readonly string[])[],
    footer: readonly (readonly string[])[],
    rowHeaders: boolean,
  ): void {
    const { doc } = this;
    const total = columns.reduce((n, c) => n + (c.weight ?? 1), 0);
    const widths = columns.map((c) => (this.width * (c.weight ?? 1)) / total);
    const xs = widths.map((_, i) => this.left + widths.slice(0, i).reduce((a, b) => a + b, 0));
    const pad = 3;

    const table = doc.struct("Table");
    this.root.add(table);
    this.style("semibold", 10);
    this.ensure(48);
    this.text(table, "Caption", caption);
    doc.y += 3;

    const measure = (cells: readonly string[], bold: boolean) => {
      this.style(bold ? "semibold" : "regular", BODY);
      return (
        Math.max(
          ...cells.map((c, i) =>
            doc.heightOfString(this.safe(c) || " ", { width: (widths[i] ?? 0) - pad * 2 }),
          ),
          BODY,
        ) +
        pad * 2
      );
    };
    const drawCells = (cells: readonly string[], y: number, bold: (i: number) => boolean) => {
      cells.forEach((c, i) => {
        this.style(bold(i) ? "semibold" : "regular", BODY, rowHeaders && i === 0 ? MUTED : TEXT);
        doc.text(this.safe(c) || " ", (xs[i] ?? 0) + pad, y + pad, {
          width: (widths[i] ?? 0) - pad * 2,
          align: columns[i]?.numeric ? "right" : "left",
        });
      });
    };
    const rule = (y: number, strong = false) =>
      this.artifact(() => {
        doc
          .moveTo(this.left, y)
          .lineTo(this.left + this.width, y)
          .lineWidth(strong ? 0.9 : 0.4)
          .strokeColor(strong ? MUTED : RULE)
          .stroke();
      });

    const header = rowHeaders ? null : columns.map((c) => c.label);
    const headerHeight = header ? measure(header, true) : 0;
    const drawHeaderArtifact = () => {
      if (!header) return;
      const y = doc.y;
      this.artifact(() => drawCells(header, y, () => true), "Pagination");
      rule(y + headerHeight, true);
      doc.y = y + headerHeight;
    };

    if (header) {
      const y = doc.y;
      const tr = doc.struct("TR");
      table.add(tr);
      header.forEach((label, i) => {
        const th = doc.struct("TH", { scope: "Column" } as never);
        tr.add(th);
        this.style("semibold", BODY);
        th.add(
          doc.struct("Span", () => {
            doc.text(this.safe(label) || " ", (xs[i] ?? 0) + pad, y + pad, {
              width: (widths[i] ?? 0) - pad * 2,
              align: columns[i]?.numeric ? "right" : "left",
            });
          }),
        );
        th.end();
      });
      tr.end();
      rule(y + headerHeight, true);
      doc.y = y + headerHeight;
    }

    const bodyRow = (cells: readonly string[], strong: boolean) => {
      const height = measure(cells, strong);
      if (doc.y + height > this.bottom) {
        doc.addPage();
        doc.x = this.left;
        doc.y = doc.page.margins.top;
        drawHeaderArtifact();
      }
      const y = doc.y;
      const tr = doc.struct("TR");
      table.add(tr);
      cells.forEach((c, i) => {
        const isHeader = rowHeaders && i === 0;
        const cell = doc.struct(
          isHeader ? "TH" : "TD",
          isHeader ? ({ scope: "Row" } as never) : {},
        );
        tr.add(cell);
        this.style(strong || isHeader ? "semibold" : "regular", BODY, isHeader ? MUTED : TEXT);
        cell.add(
          doc.struct("Span", () => {
            doc.text(this.safe(c) || " ", (xs[i] ?? 0) + pad, y + pad, {
              width: (widths[i] ?? 0) - pad * 2,
              align: columns[i]?.numeric ? "right" : "left",
            });
          }),
        );
        cell.end();
      });
      tr.end();
      rule(y + height, strong);
      doc.y = y + height;
    };
    for (const r of rows) bodyRow(r, false);
    for (const r of footer) bodyRow(r, true);
    table.end();
    doc.x = this.left;
    doc.y += GAP * 1.5;
  }

  /** Page numbers and the record key on every page, as pagination artifacts. */
  private footers(): void {
    const { doc, model } = this;
    const range = doc.bufferedPageRange();
    const end = range.start + range.count;
    for (let i = this.firstPage; i < end; i += 1) {
      doc.switchToPage(i);
      const y = doc.page.height - MARGIN - SMALL;
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      this.artifact(() => {
        this.style("regular", SMALL, MUTED);
        doc.text(this.safe(model.facts.recordKey), this.left, y, {
          width: this.width / 2,
          lineBreak: false,
        });
        const local = i - this.firstPage + 1;
        doc.text(
          this.safe(
            this.pagination
              ? model.facts.labels.page(this.pagination.offset + local - 1, this.pagination.total)
              : model.facts.labels.page(local, end - this.firstPage),
          ),
          this.left + this.width / 2,
          y,
          { width: this.width / 2, align: "right", lineBreak: false },
        );
      }, "Pagination");
      if (model.watermark) this.watermark(model.watermark.text);
      doc.page.margins.bottom = bottomMargin;
    }
  }

  /**
   * The Section 8.6 watermark across the page: light, diagonal, and an artifact, since the header
   * already carries the same text in the reading order.
   */
  private watermark(text: string): void {
    const { doc } = this;
    const value = this.safe(text);
    const cx = doc.page.width / 2;
    const cy = doc.page.height / 2;
    const span = Math.hypot(doc.page.width, doc.page.height) * 0.7;
    const size = Math.max(9, Math.min(26, span / (Math.max(value.length, 1) * 0.56)));
    this.artifact(() => {
      doc.save();
      doc.opacity(0.16);
      this.style("semibold", size, MUTED);
      doc.rotate(-32, { origin: [cx, cy] });
      doc.text(value, cx - span / 2, cy - size / 2, {
        width: span,
        align: "center",
        lineBreak: false,
      });
      doc.restore();
    });
  }
}
