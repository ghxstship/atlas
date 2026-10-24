import type { DocumentBlock, DocumentColumn, DocumentModel, Paper } from "./model.ts";

/** Page orientation: portrait by default; wide forms such as the WH-347 and OSHA 300 print landscape. */
export type Orientation = "portrait" | "landscape";
import { qrMatrix } from "./qr.ts";

/**
 * Renders a document model to tagged PDF/UA-1 with pdfkit 0.20.2 (ADR 0031): a structure tree in
 * reading order, the document language and title, embedded Inter fonts, alternative text on the
 * logo and the QR code, real table headers with a scope, and page furniture marked as artifacts.
 * Server only: pdfkit loads on first use and never reaches a browser bundle.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- pdfkit's types omit the tagging internals used here. */
type Doc = any;
type StructElement = any;

const MARGIN = 54;
const FOOTER = 28;
const GAP = 10;
const BODY = 9.5;
const SMALL = 8;
const TEXT = "black";
const MUTED = "dimgray";
const RULE = "silver";
const QR_SIZE = 72;

const SIZES: Record<Paper, "LETTER" | "A4"> = { letter: "LETTER", a4: "A4" };

let fontCache: { regular: Buffer; semibold: Buffer } | null = null;

async function fonts(): Promise<{ regular: Buffer; semibold: Buffer }> {
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

export async function renderDocumentPdf(
  model: DocumentModel,
  options: { readonly paper: Paper; readonly orientation?: Orientation },
): Promise<Uint8Array> {
  const [{ default: PDFDocument }, font] = await Promise.all([import("pdfkit"), fonts()]);
  return new Promise((resolve, reject) => {
    // pdfkit's types lag the library: they omit the PDF/UA subset and a font given as bytes.
    const pdfOptions: Record<string, unknown> = {
      size: SIZES[options.paper],
      layout: options.orientation ?? "portrait",
      margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: MARGIN + FOOTER },
      pdfVersion: "1.7",
      subset: "PDF/UA",
      tagged: true,
      lang: model.lang,
      displayTitle: true,
      bufferPages: true,
      font: font.regular,
      info: {
        Title: model.title,
        Author: model.brand.legalEntity ?? model.brand.name,
        Subject: `${model.facts.recordKey} v${model.facts.templateVersion}`,
        ...(model.watermark ? { Keywords: model.watermark.text } : {}),
        Creator: "XOS",
        Producer: "XOS",
        CreationDate: new Date(model.facts.generatedAtIso),
      },
    };
    const doc: Doc = new PDFDocument(pdfOptions as never);
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
    try {
      doc.registerFont("regular", font.regular);
      doc.registerFont("semibold", font.semibold);
      new Renderer(doc, model).render();
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

class Renderer {
  private readonly root: StructElement;
  private readonly glyphs = new Map<number, boolean>();
  private readonly doc: Doc;
  private readonly model: DocumentModel;

  constructor(doc: Doc, model: DocumentModel) {
    this.doc = doc;
    this.model = model;
    this.root = doc.struct("Document");
    doc.addStructure(this.root);
  }

  private get left(): number {
    return this.doc.page.margins.left;
  }

  private get width(): number {
    return this.doc.page.width - this.doc.page.margins.left - this.doc.page.margins.right;
  }

  private get bottom(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  /** Text safe to draw with the embedded font. */
  private safe(text: string): string {
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

  private style(weight: "regular" | "semibold", size: number, color = TEXT): void {
    this.doc.font(weight).fontSize(size).fillColor(color);
  }

  private ensure(height: number): void {
    if (this.doc.y + height > this.bottom) {
      this.doc.addPage();
      this.doc.x = this.left;
      this.doc.y = this.doc.page.margins.top;
    }
  }

  /** One tagged text element (P, H1, H2, Caption) added to a parent. */
  private text(
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

  private artifact(draw: () => void, type: "Layout" | "Pagination" = "Layout"): void {
    this.doc.markContent("Artifact", { type });
    draw();
    this.doc.endMarkedContent();
  }

  render(): void {
    this.header();
    for (const block of this.model.blocks) this.block(block);
    this.root.end();
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

    const qrX = this.left + this.width - QR_SIZE;
    const matrix = qrMatrix(facts.recordUrl);
    const cell = QR_SIZE / matrix.length;
    const qr = doc.struct("Figure", { alt: this.safe(facts.labels.qrAlt) }, () => {
      doc.save();
      matrix.forEach((row, r) =>
        row.forEach((dark, c) => {
          if (dark) doc.rect(qrX + c * cell, top + r * cell, cell, cell);
        }),
      );
      doc.fillColor(TEXT).fill();
      doc.restore();
    });
    this.root.add(qr);

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
    for (let i = range.start; i < range.start + range.count; i += 1) {
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
        doc.text(
          this.safe(model.facts.labels.page(i - range.start + 1, range.count)),
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
