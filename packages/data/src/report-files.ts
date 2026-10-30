import type { PreviewCell, ReportPreview } from "./report-builder.ts";
import type { Database } from "./database.types.ts";

/**
 * Report files in .xlsx and PDF (A43, finding A38-004; Section 4.6.4): the same summary a report
 * run writes as CSV, rendered with exceljs 4.4.0 and pdfkit 0.20.2. Both run on the server only
 * (the report-run worker and its Edge Function), never in a browser bundle, and load on first use,
 * so nothing else that shares the Edge bundle pays for them at start-up.
 *
 * Money stays NULL-aware: a cell shows the sum of its priced inputs, and the unpriced count of each
 * row is its own column, so a blank price is never read as zero (Section 3.7).
 *
 * The table PDF is shared with collection exports (A102, export-renders.ts), and both stamp the
 * Section 8.6 watermark, the viewer's email and the time, on every page of a Confidential or
 * Restricted file.
 */

export type DataClassification = Database["app"]["Enums"]["data_classification"];

/** Section 8.6: PDFs and images of Confidential and Restricted data carry the viewer and the time. */
export function watermarked(classification: DataClassification): boolean {
  return classification === "Confidential" || classification === "Restricted";
}

/** The watermark line when the caller gave no translated copy. */
export function defaultWatermark(input: { readonly email: string; readonly at: Date }): string {
  return `Exported by ${input.email} on ${input.at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export interface ReportFileInput {
  readonly title: string;
  /** One line under the title: who it ran for, when, the row and unpriced counts. */
  readonly subtitle: string;
  readonly preview: ReportPreview;
  readonly headers: readonly string[];
  readonly groupHeader: string | null;
  /** Header of the unpriced count column, shown when the report has money. */
  readonly unpricedHeader: string;
  /** Shown under the table when the source rows were cut at the run limit. */
  readonly truncatedNote: string | null;
  /**
   * The Section 8.6 watermark of a report whose columns classify above Internal: who the PDF was made for and
   * when, already translated. PDFs carry it on every page; null leaves the file unmarked.
   */
  readonly watermark?: string | null;
}

const fractionDigits = (currency: string): number =>
  currency
    ? (new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2)
    : 2;

/** A money cell in major units, or null while unpriced. */
export function majorUnits(cell: Extract<PreviewCell, { kind: "money" }>): number | null {
  if (cell.totalMinor === null) return null;
  return cell.totalMinor / 10 ** fractionDigits(cell.currency);
}

/** A cell as display text: money with its currency code, blank when unpriced. */
export function cellText(cell: PreviewCell): string {
  if (cell.kind === "value") return cell.value === null ? "" : String(cell.value);
  const major = majorUnits(cell);
  if (major === null) return "";
  return `${major.toFixed(fractionDigits(cell.currency))} ${cell.currency}`.trim();
}

const hasMoney = (preview: ReportPreview) => preview.columns.some((c) => c.type === "money");

const rowUnpriced = (cells: readonly PreviewCell[]) =>
  Math.max(0, ...cells.map((c) => (c.kind === "money" ? c.unpricedCount : 0)));

/** The table every format writes: header row, then one row per group or source row. */
export function reportMatrix(input: ReportFileInput): {
  readonly header: readonly string[];
  readonly rows: readonly (readonly PreviewCell[])[];
  readonly groups: readonly (string | null)[];
  readonly unpriced: readonly number[];
} {
  const money = hasMoney(input.preview);
  return {
    header: [
      ...(input.groupHeader ? [input.groupHeader] : []),
      ...input.headers,
      ...(money ? [input.unpricedHeader] : []),
    ],
    rows: input.preview.rows.map((r) => r.cells),
    groups: input.preview.rows.map((r) => r.group),
    unpriced: money ? input.preview.rows.map((r) => rowUnpriced(r.cells)) : [],
  };
}

/** The .xlsx workbook: one sheet, money as numbers in its currency's decimals. */
export async function renderReportXlsx(input: ReportFileInput): Promise<Uint8Array> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "XOS";
  const sheet = workbook.addWorksheet(input.title.slice(0, 31) || "Report");
  const m = reportMatrix(input);
  sheet.addRow([input.title]).font = { bold: true, size: 14 };
  sheet.addRow([input.subtitle]);
  sheet.addRow([]);
  const header = sheet.addRow([...m.header]);
  header.font = { bold: true };
  const money = hasMoney(input.preview);
  m.rows.forEach((cells, i) => {
    const values: (string | number | null)[] = [];
    if (input.groupHeader) values.push(m.groups[i] ?? "");
    for (const c of cells) {
      values.push(c.kind === "value" ? c.value : majorUnits(c));
    }
    if (money) values.push(m.unpriced[i] ?? 0);
    const row = sheet.addRow(values);
    cells.forEach((c, j) => {
      if (c.kind !== "money") return;
      const digits = fractionDigits(c.currency);
      const cell = row.getCell(j + 1 + (input.groupHeader ? 1 : 0));
      cell.numFmt = `#,##0${digits > 0 ? `.${"0".repeat(digits)}` : ""} "${c.currency}"`;
    });
  });
  if (input.truncatedNote) {
    sheet.addRow([]);
    sheet.addRow([input.truncatedNote]);
  }
  sheet.columns.forEach((column) => {
    column.width = 18;
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

/** Collects a pdfkit document's output once it ends. Call before drawing, then `doc.end()`. */
export function pdfBytes(doc: PDFKit.PDFDocument): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      resolve(out);
    });
  });
}

/**
 * The Section 8.6 watermark on every page of a document made with `bufferPages: true`: the text once across
 * the page, light and diagonal, and once in the bottom margin, where it stays legible over a full table. The
 * same text is the document's Keywords, so the file says whom it was made for even when printed in part.
 */
export function stampWatermark(doc: PDFKit.PDFDocument, text: string): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const { width, height, margins } = doc.page;
    const bottom = margins.bottom;
    // Drawing in the margin must never start a new page.
    doc.page.margins.bottom = 0;
    const span = Math.hypot(width, height) * 0.7;
    const size = Math.max(9, Math.min(26, span / (Math.max(text.length, 1) * 0.56)));
    doc.save();
    doc.opacity(0.14).font("Helvetica-Bold").fontSize(size).fillColor("gray");
    doc.rotate(-32, { origin: [width / 2, height / 2] });
    doc.text(text, width / 2 - span / 2, height / 2 - size / 2, {
      width: span,
      align: "center",
      lineBreak: false,
    });
    doc.restore();
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("dimgray")
      .text(text, margins.left, height - bottom / 2 - 4, {
        width: width - margins.left - margins.right,
        align: "center",
        lineBreak: false,
      });
    doc.fillColor("black");
    doc.page.margins.bottom = bottom;
  }
}

/** A table document in PDF: what reports and collection exports both print. */
export interface TablePdfInput {
  readonly title: string;
  /** One line under the title. */
  readonly subtitle: string;
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Right-aligned columns (numbers and money), by position. */
  readonly numeric: readonly boolean[];
  /** Shown under the table, such as the note that rows were cut at a limit. */
  readonly note: string | null;
  /** The Section 8.6 watermark text, stamped on every page; null leaves the file unmarked. */
  readonly watermark: string | null;
  /** Point size of the table text; 9 by default. */
  readonly fontSize?: number;
}

/** Tallest a row may grow before its text is cut with an ellipsis, so a long cell never outgrows a page. */
const MAX_ROW_HEIGHT = 160;

/** The PDF of a table: title, subtitle, then the rows with the header repeated on every page. */
export async function renderTablePdf(input: TablePdfInput): Promise<Uint8Array> {
  const { default: PDFDocument } = await import("pdfkit");
  const doc = new PDFDocument({
    size: "LETTER",
    layout: "landscape",
    margin: 40,
    bufferPages: true,
    info: {
      Title: input.title,
      Creator: "XOS",
      ...(input.watermark ? { Keywords: input.watermark } : {}),
    },
  });
  const bytes = pdfBytes(doc);
  const size = input.fontSize ?? 9;
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const columnWidth = width / Math.max(input.header.length, 1);
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  doc.font("Helvetica-Bold").fontSize(16).text(input.title, left, doc.y, { width });
  doc.moveDown(0.25);
  doc.font("Helvetica").fontSize(9).fillColor("dimgray").text(input.subtitle, { width });
  doc.fillColor("black").moveDown(1);

  const drawRow = (cells: readonly string[], bold: boolean) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
    const textHeight = Math.min(
      MAX_ROW_HEIGHT,
      Math.max(...cells.map((c) => doc.heightOfString(c || " ", { width: columnWidth - 6 })), 10),
    );
    const height = textHeight + 6;
    if (doc.y + height > bottom()) doc.addPage();
    const y = doc.y;
    cells.forEach((c, i) => {
      doc.text(c, left + i * columnWidth + 3, y + 3, {
        width: columnWidth - 6,
        height: textHeight,
        ellipsis: true,
        align: input.numeric[i] ? "right" : "left",
      });
    });
    doc
      .moveTo(left, y + height)
      .lineTo(left + width, y + height)
      .lineWidth(0.5)
      .strokeColor("silver")
      .stroke();
    doc.x = left;
    doc.y = y + height;
  };

  drawRow(input.header, true);
  for (const cells of input.rows) {
    if (doc.y + 20 > bottom()) {
      doc.addPage();
      drawRow(input.header, true);
    }
    drawRow(cells, false);
  }
  if (input.note) {
    doc.moveDown(1).font("Helvetica-Oblique").fontSize(9).text(input.note, left, doc.y, { width });
  }
  if (input.watermark) stampWatermark(doc, input.watermark);
  doc.end();
  return bytes;
}

/** The report PDF: title, subtitle, then the table with repeated headers, watermarked when asked. */
export async function renderReportPdf(input: ReportFileInput): Promise<Uint8Array> {
  const m = reportMatrix(input);
  const money = hasMoney(input.preview);
  return renderTablePdf({
    title: input.title,
    subtitle: input.subtitle,
    header: m.header,
    rows: m.rows.map((cells, i) => [
      ...(input.groupHeader ? [m.groups[i] ?? ""] : []),
      ...cells.map(cellText),
      ...(money ? [String(m.unpriced[i] ?? 0)] : []),
    ]),
    numeric: [
      ...(input.groupHeader ? [false] : []),
      ...input.preview.columns.map((c) => c.type === "money" || c.type === "number"),
      ...(money ? [true] : []),
    ],
    note: input.truncatedNote,
    watermark: input.watermark ?? null,
  });
}
