import { printable } from "./render.ts";

/**
 * The Section 8.6 watermark on an uploaded PDF (A103, finding A65-016). A Confidential or Restricted
 * PDF someone uploaded leaves only with the viewer's email and the time on every page: pdf-lib 1.17.1
 * opens the file, keeps every page and its content as they are, and draws the line twice over each
 * one, light and diagonal across the middle and small along the bottom edge, in the page's own
 * orientation. Both copies are marked as artifacts so a tagged PDF keeps its reading order. The
 * Standard 14 Helvetica draws the text, so nothing is embedded; a character it lacks falls back to its
 * base letter or a question mark. An encrypted or unreadable file is refused, never sent unmarked.
 * Server only: pdf-lib loads on first use.
 */

export type PdfWatermarkRefusal = "encrypted" | "unreadable";

export type PdfWatermarkResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly pages: number }
  | { readonly ok: false; readonly reason: PdfWatermarkRefusal };

/** The diagonal copy: the angle and opacity of the generated documents' watermark (render.ts). */
const DIAGONAL_DEGREES = 32;
const DIAGONAL_OPACITY = 0.16;
/** The bottom line: small, inset from the edge, and readable. */
const LINE_SIZE = 7;
const LINE_INSET = 10;
const LINE_OPACITY = 0.85;
/** dimgray, the generated documents' muted text color. */
const GRAY = 0.41;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Maps a point of the page as displayed (origin at its lower left, `u` across, `v` up) to the page's own
 * coordinates, for a page shown turned clockwise by `quarter` degrees (its /Rotate of 0, 90, 180 or 270).
 */
export function displayedPoint(
  box: Box,
  quarter: 0 | 90 | 180 | 270,
  u: number,
  v: number,
): { readonly x: number; readonly y: number } {
  switch (quarter) {
    case 90:
      return { x: box.x + box.width - v, y: box.y + u };
    case 180:
      return { x: box.x + box.width - u, y: box.y + box.height - v };
    case 270:
      return { x: box.x + v, y: box.y + box.height - u };
    default:
      return { x: box.x + u, y: box.y + v };
  }
}

function quarterTurn(angle: number): 0 | 90 | 180 | 270 {
  const turned = ((Math.round(angle) % 360) + 360) % 360;
  return turned === 90 || turned === 180 || turned === 270 ? turned : 0;
}

/**
 * Stamps `text` on every page of a PDF and answers the new file, or why it cannot be stamped: an
 * encrypted file (pdf-lib cannot rewrite one) or one that does not parse.
 */
export async function stampPdfWatermark(
  bytes: Uint8Array,
  text: string,
): Promise<PdfWatermarkResult> {
  const lib = await import("pdf-lib");
  try {
    // Loaded with ignoreEncryption only to ask: pdf-lib cannot write an encrypted file back.
    const doc = await lib.PDFDocument.load(bytes, {
      updateMetadata: false,
      ignoreEncryption: true,
    });
    if (doc.isEncrypted) return { ok: false, reason: "encrypted" };
    const pages = doc.getPages();
    if (pages.length === 0) return { ok: false, reason: "unreadable" };
    const font = await doc.embedFont(lib.StandardFonts.Helvetica);
    const glyphs = new Set(font.getCharacterSet());
    const value = printable(text.replace(/\s+/gu, " ").trim(), (cp) => glyphs.has(cp));
    const unit = Math.max(font.widthOfTextAtSize(value, 1), 1);
    const color = lib.grayscale(GRAY);

    for (const page of pages) {
      const box = page.getCropBox();
      const quarter = quarterTurn(page.getRotation().angle);
      const width = quarter % 180 === 0 ? box.width : box.height;
      const height = quarter % 180 === 0 ? box.height : box.width;
      page.pushOperators(lib.beginMarkedContent("Artifact"));

      // Across the middle, centered on the page as displayed.
      const span = Math.hypot(width, height) * 0.6;
      const size = Math.max(9, Math.min(26, span / unit));
      const theta = (DIAGONAL_DEGREES * Math.PI) / 180;
      const half = (unit * size) / 2;
      const lift = (size * 0.7) / 2;
      const start = displayedPoint(
        box,
        quarter,
        width / 2 - half * Math.cos(theta) + lift * Math.sin(theta),
        height / 2 - half * Math.sin(theta) - lift * Math.cos(theta),
      );
      page.drawText(value, {
        ...start,
        size,
        font,
        color,
        opacity: DIAGONAL_OPACITY,
        rotate: lib.degrees(quarter + DIAGONAL_DEGREES),
      });

      // Along the bottom edge, shrunk to fit a narrow page.
      const lineSize = Math.max(4, Math.min(LINE_SIZE, (width - 2 * LINE_INSET) / unit));
      page.drawText(value, {
        ...displayedPoint(box, quarter, LINE_INSET, LINE_INSET),
        size: lineSize,
        font,
        color,
        opacity: LINE_OPACITY,
        rotate: lib.degrees(quarter),
      });

      page.pushOperators(lib.endMarkedContent());
    }
    const out = await doc.save({ useObjectStreams: false, addDefaultPage: false });
    return { ok: true, bytes: out, pages: pages.length };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
