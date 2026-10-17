import type { PreviewCell, ReportPreview } from "./report-builder.ts";

/**
 * Report files in .xlsx and PDF (A43, finding A38-004; Section 4.6.4): the same summary a report
 * run writes as CSV, rendered with exceljs 4.4.0 and pdfkit 0.20.2. Both run on the server only
 * (the report-run worker and its Edge Function), never in a browser bundle, and load on first use,
 * so nothing else that shares the Edge bundle pays for them at start-up.
 *
 * Money stays NULL-aware: a cell shows the sum of its priced inputs, and the unpriced count of each
 * row is its own column, so a blank price is never read as zero (Section 3.7).
 */

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

/** The PDF: title, subtitle, then the table with repeated headers across pages. */
export async function renderReportPdf(input: ReportFileInput): Promise<Uint8Array> {
  const { default: PDFDocument } = await import("pdfkit");
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      layout: "landscape",
      margin: 40,
      info: { Title: input.title, Creator: "XOS" },
    });
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

    const m = reportMatrix(input);
    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const columns = Math.max(m.header.length, 1);
    const columnWidth = width / columns;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const money = hasMoney(input.preview);

    doc.font("Helvetica-Bold").fontSize(16).text(input.title, left, doc.y, { width });
    doc.moveDown(0.25);
    doc.font("Helvetica").fontSize(9).fillColor("dimgray").text(input.subtitle, { width });
    doc.fillColor("black").moveDown(1);

    const drawRow = (cells: readonly string[], bold: boolean, numeric: readonly boolean[]) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
      const height =
        Math.max(
          ...cells.map((c) => doc.heightOfString(c || " ", { width: columnWidth - 6 })),
          10,
        ) + 6;
      if (doc.y + height > bottom()) doc.addPage();
      const y = doc.y;
      cells.forEach((c, i) => {
        doc.text(c, left + i * columnWidth + 3, y + 3, {
          width: columnWidth - 6,
          align: numeric[i] ? "right" : "left",
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

    const numeric = [
      ...(input.groupHeader ? [false] : []),
      ...input.preview.columns.map((c) => c.type === "money" || c.type === "number"),
      ...(money ? [true] : []),
    ];
    drawRow(m.header, true, numeric);
    m.rows.forEach((cells, i) => {
      if (doc.y + 20 > bottom()) {
        doc.addPage();
        drawRow(m.header, true, numeric);
      }
      drawRow(
        [
          ...(input.groupHeader ? [m.groups[i] ?? ""] : []),
          ...cells.map(cellText),
          ...(money ? [String(m.unpriced[i] ?? 0)] : []),
        ],
        false,
        numeric,
      );
    });
    if (input.truncatedNote) {
      doc.moveDown(1).font("Helvetica-Oblique").fontSize(9).text(input.truncatedNote, left, doc.y, {
        width,
      });
    }
    doc.end();
  });
}
