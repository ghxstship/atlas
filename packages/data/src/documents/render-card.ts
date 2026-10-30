import type { CardPaper, DocumentBlock } from "./model.ts";
import { isEmbeddableImage, MUTED, RULE, TaggedWriter, TEXT } from "./render.ts";

/**
 * The card layout of the credential badge (P5, ADR 0031 amendment): A6 and the CR80 ID-1 card, one page each,
 * tagged PDF/UA-1 like every page document. The template builds the blocks already in card order (portrait, the
 * holder's name as a heading, the scan code, compact paragraphs and, on A6, the fields table); this layout places
 * them by kind with the card's metrics and never reads a label or a position. The portrait and the scan code share a
 * row; the scan code is the only QR on a card, since two codes on a 54 mm card send gate staff to the wrong one.
 * Server only: loaded by render.ts, which loads pdfkit on first use.
 */

interface CardMetrics {
  readonly logo: [number, number];
  readonly brand: number;
  readonly portrait: [number, number];
  readonly qr: number;
  readonly caption: number;
  /** The holder's name: the largest size, and the smallest it shrinks to before it wraps past three lines. */
  readonly name: [number, number];
  readonly body: number;
  readonly table: number;
  readonly facts: number;
  readonly gap: number;
}

const METRICS: Record<CardPaper, CardMetrics> = {
  cr80: {
    logo: [100, 18],
    brand: 8,
    portrait: [64, 80],
    qr: 64,
    caption: 5,
    name: [12, 9],
    body: 6.5,
    table: 6,
    facts: 5.5,
    gap: 4,
  },
  a6: {
    logo: [160, 28],
    brand: 11,
    portrait: [110, 138],
    qr: 96,
    caption: 6.5,
    name: [18, 12],
    body: 8.5,
    table: 7.5,
    facts: 6.5,
    gap: 7,
  },
};

const NAME_LINES = 3;

export class CardRenderer extends TaggedWriter {
  private readonly metrics: CardMetrics;
  /** Where the portrait and scan code row starts, once a block of the row is drawn. */
  private rowTop: number | null = null;

  constructor(
    doc: ConstructorParameters<typeof TaggedWriter>[0],
    model: ConstructorParameters<typeof TaggedWriter>[1],
    parent: ConstructorParameters<typeof TaggedWriter>[2],
    paper: CardPaper,
  ) {
    super(doc, model, parent);
    this.metrics = METRICS[paper];
  }

  render(): void {
    // A badge is one card: nothing may flow onto a second page, so pdfkit's page break at the bottom margin is off
    // while the card is drawn and the facts line sits on the card's own bottom edge.
    const page = this.doc.page;
    const edge = page.margins.bottom;
    page.margins.bottom = 0;
    try {
      this.border();
      this.brand();
      for (const block of this.model.blocks) this.block(block);
      this.facts(edge);
    } finally {
      page.margins.bottom = edge;
    }
  }

  private border(): void {
    const { doc } = this;
    this.artifact(() => {
      doc
        .roundedRect(1.5, 1.5, doc.page.width - 3, doc.page.height - 3, 4)
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke();
    });
  }

  /** The brand logo as a Figure, or the brand name as text, over the accent rule. */
  private brand(): void {
    const { doc, model, metrics: m } = this;
    const top = doc.page.margins.top;
    const logo = model.brand.logo;
    let bottom: number;
    if (logo && isEmbeddableImage(logo.bytes)) {
      this.root.add(
        doc.struct("Figure", { alt: this.safe(logo.alt) }, () => {
          doc.image(Buffer.from(logo.bytes), this.left, top, { fit: m.logo });
        }),
      );
      bottom = top + m.logo[1];
    } else {
      this.style("semibold", m.brand);
      this.text(this.root, "P", model.brand.name, { y: top });
      bottom = doc.y;
    }
    const accent = /^#[0-9a-f]{6}$/i.test(model.brand.accentHex ?? "")
      ? (model.brand.accentHex as string)
      : TEXT;
    const rule = bottom + m.gap / 2;
    this.artifact(() => {
      doc
        .moveTo(this.left, rule)
        .lineTo(this.left + this.width, rule)
        .lineWidth(1)
        .strokeColor(accent)
        .stroke();
    });
    doc.x = this.left;
    doc.y = rule + m.gap;
  }

  private block(block: DocumentBlock): void {
    const { doc, metrics: m } = this;
    switch (block.kind) {
      case "portrait": {
        const top = this.row();
        this.portrait(block, this.left, top, m.portrait[0], m.portrait[1], m.caption);
        return;
      }
      case "scan-code": {
        const top = this.row();
        const x = this.left + this.width - m.qr;
        this.qr(block.payload, x, top, m.qr, block.alt);
        this.style("regular", m.caption, MUTED);
        this.text(this.root, "P", block.caption, {
          x,
          y: top + m.qr + 2,
          width: m.qr,
          align: "center",
        });
        return;
      }
      case "heading": {
        this.name(block.text);
        return;
      }
      case "paragraph": {
        this.style(block.size === "large" ? "semibold" : "regular", m.body);
        for (const part of block.text.split(/\n{2,}/)) {
          if (!part.trim()) continue;
          this.text(this.root, "P", part.trim(), { y: doc.y });
          doc.y += m.body * 0.3;
        }
        return;
      }
      case "fields": {
        this.fields(block.caption, block.fields);
        return;
      }
      case "image":
      case "table":
        // The badge template puts neither on a card; a page document never reaches this layout.
        throw new Error(`A ${block.kind} block does not fit on a card.`);
    }
  }

  /** The top of the portrait and scan code row; the text below starts under its tallest part. */
  private row(): number {
    const { doc, metrics: m } = this;
    if (this.rowTop !== null) return this.rowTop;
    const top: number = doc.y;
    const captionRoom = m.caption * 2.6 + 2;
    doc.y = top + Math.max(m.portrait[1], m.qr + captionRoom) + m.gap;
    this.rowTop = top;
    return top;
  }

  /**
   * The holder's name as the card's H1, semibold: the largest size that fits on three lines, shrinking to the
   * smallest, then wrapping as far as it needs. A name is never truncated.
   */
  private name(text: string): void {
    const { doc, metrics: m } = this;
    const [largest, smallest] = m.name;
    let size = largest;
    for (; size > smallest; size -= 0.5) {
      this.style("semibold", size);
      const lines =
        doc.heightOfString(this.safe(text), { width: this.width }) / doc.currentLineHeight(true);
      if (lines <= NAME_LINES + 0.01) break;
    }
    this.style("semibold", Math.max(size, smallest));
    this.text(this.root, "H1", text, { y: doc.y });
    doc.y += m.gap / 2;
  }

  /** The A6 fields as a table of row headers and values. */
  private fields(caption: string, fields: readonly { label: string; value: string }[]): void {
    const { doc, metrics: m } = this;
    const table = doc.struct("Table");
    this.root.add(table);
    doc.y += m.gap / 2;
    this.style("semibold", m.table);
    this.text(table, "Caption", caption, { y: doc.y });
    const labelWidth = this.width * 0.36;
    const valueWidth = this.width - labelWidth - 4;
    for (const f of fields) {
      const y = doc.y + 1.5;
      const row = doc.struct("TR");
      table.add(row);
      this.style("regular", m.table, MUTED);
      const label = this.safe(f.label) || " ";
      const th = doc.struct("TH", { scope: "Row" } as never);
      row.add(th);
      th.add(
        doc.struct("Span", () => {
          doc.text(label, this.left, y, { width: labelWidth });
        }),
      );
      th.end();
      const labelBottom = doc.y;
      this.style("semibold", m.table);
      const value = this.safe(f.value) || " ";
      const td = doc.struct("TD");
      row.add(td);
      td.add(
        doc.struct("Span", () => {
          doc.text(value, this.left + labelWidth + 4, y, { width: valueWidth });
        }),
      );
      td.end();
      row.end();
      doc.y = Math.max(doc.y, labelBottom);
    }
    table.end();
    doc.x = this.left;
    doc.y += m.gap / 2;
  }

  /** Record key, template version and generation time, in one small line read after the badge. */
  private facts(edge: number): void {
    const { doc, model, metrics: m } = this;
    const f = model.facts;
    this.style("regular", m.facts, MUTED);
    const line = [
      `${f.labels.recordKey} ${f.recordKey}`,
      `${f.labels.version} ${f.templateVersion}`,
      `${f.labels.generatedAt} ${f.generatedAt}`,
    ].join(" · ");
    const height = doc.heightOfString(this.safe(line), { width: this.width });
    const floor = doc.page.height - edge - height;
    this.text(this.root, "P", line, { y: Math.max(doc.y + m.gap / 2, floor) });
  }
}
