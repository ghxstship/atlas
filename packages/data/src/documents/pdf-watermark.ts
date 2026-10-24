import type * as PdfLibModule from "pdf-lib";
import { printable } from "./render.ts";

type PdfLib = typeof PdfLibModule;

/**
 * The Section 8.6 watermark on an uploaded PDF (A103, finding A65-016). A Confidential or Restricted
 * PDF someone uploaded leaves only with the viewer's email and the time on every page: pdf-lib 1.17.1
 * opens the file, keeps every page and its content as they are, and draws the line twice over each
 * one, light and diagonal across the middle and small along the bottom edge, in the page's own
 * orientation. Both copies are marked as artifacts so a tagged PDF keeps its reading order. The
 * Standard 14 Helvetica draws the text, so nothing is embedded; a character it lacks falls back to its
 * base letter or a question mark. An encrypted or unreadable file is refused, never sent unmarked.
 *
 * The file is untrusted, so the overlay does not rely on it behaving: the page's own content is
 * balanced before the line is drawn (every save it leaves open is restored, a restore it makes
 * without a save is matched, an open text object or marked-content sequence is closed), so a crafted
 * or malformed page cannot leave a transform, a clip or hidden optional content over the line, and a
 * page that ends inside a string or an inline image is refused. Reversed or oversized boxes are
 * normalized, and an XFA form, which a viewer would show instead of the pages, is dropped. Reading is
 * bounded too (see {@link PDF_WATERMARK_LIMITS}): what is inflated while reading the file counts
 * against a budget, checked before pdf-lib inflates object streams, so a deflate bomb is refused
 * instead of filling the server's memory. Server only: pdf-lib and node:zlib load on first use.
 */

export type PdfWatermarkRefusal = "encrypted" | "unreadable" | "too-large";

export type PdfWatermarkResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly pages: number }
  | { readonly ok: false; readonly reason: PdfWatermarkRefusal; readonly detail?: string };

/** Bounds on reading an untrusted upload in the request path. */
export interface PdfWatermarkLimits {
  /** The file itself; the attachments bucket takes up to 50 MiB. */
  readonly bytes: number;
  readonly pages: number;
  /** Object and cross-reference streams, which pdf-lib inflates on load and keeps, in all. */
  readonly objectBytes: number;
  /** Page content, inflated one page at a time to balance it, in all. */
  readonly contentBytes: number;
  /** Any one inflated stream. */
  readonly streamBytes: number;
  /** A stream under a filter other than Flate alone (LZW, run length) is decoded only when this small. */
  readonly otherFilterBytes: number;
}

export const PDF_WATERMARK_LIMITS: PdfWatermarkLimits = {
  bytes: 50 * 1024 * 1024,
  pages: 5000,
  objectBytes: 256 * 1024 * 1024,
  contentBytes: 1024 * 1024 * 1024,
  streamBytes: 64 * 1024 * 1024,
  otherFilterBytes: 64 * 1024,
};

/** The diagonal copy: the angle and opacity of the generated documents' watermark (render.ts). */
const DIAGONAL_DEGREES = 32;
const DIAGONAL_OPACITY = 0.16;
/** The bottom line: small, inset from the edge, and readable. */
const LINE_SIZE = 7;
const LINE_INSET = 10;
const LINE_OPACITY = 0.85;
/** dimgray, the generated documents' muted text color. */
const GRAY = 0.41;

export interface Box {
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

function normalized(box: Box): Box {
  return {
    x: Math.min(box.x, box.x + box.width),
    y: Math.min(box.y, box.y + box.height),
    width: Math.abs(box.width),
    height: Math.abs(box.height),
  };
}

/**
 * The area a viewer shows: the crop box within the media box (both normalized, since a box may list its
 * corners in any order), or the media box when the two do not overlap.
 */
export function visibleBox(media: Box, crop: Box): Box {
  const m = normalized(media);
  const c = normalized(crop);
  const x = Math.max(m.x, c.x);
  const y = Math.max(m.y, c.y);
  const right = Math.min(m.x + m.width, c.x + c.width);
  const top = Math.min(m.y + m.height, c.y + c.height);
  return right > x && top > y ? { x, y, width: right - x, height: top - y } : m;
}

function quarterTurn(angle: number): 0 | 90 | 180 | 270 {
  const turned = ((Math.round(angle) % 360) + 360) % 360;
  return turned === 90 || turned === 180 || turned === 270 ? turned : 0;
}

/** What closing a page's own content takes, so whatever follows it draws in the page's initial state. */
export interface ContentBalance {
  /** Saves (q) to add before the content, for the restores it makes without a save. */
  readonly saves: number;
  /** Restores (Q) to add after it: the saves it leaves open, plus the ones added before. */
  readonly restores: number;
  /** True when it ends inside a text object (BT without ET). */
  readonly openText: boolean;
  /** True when it ends while building a path or a clip that no painting operator ended. */
  readonly openPath: boolean;
  /** Marked-content sequences (BMC, BDC) it leaves open, such as hidden optional content. */
  readonly openMarked: number;
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const regular = (c: number) => !WHITESPACE.has(c) && !DELIMITERS.has(c);
/** Operators that build a path (or set a clip on it), and those that end one. */
const PATH_BUILDING = new Set(["m", "l", "c", "v", "y", "h", "re", "W", "W*"]);
const PATH_ENDING = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);

/**
 * Reads a page's content (its streams joined, decoded) the way a viewer tokenizes it and answers what
 * closes it, or null when it ends inside a literal or hex string, an inline image, an array or a
 * dictionary, where anything drawn after it would be read as part of it. Counting an operator a viewer
 * skips only adds saves at the start or restores past the start, which leave the line in the page's
 * initial state, so the count errs on the safe side.
 */
export function contentBalance(bytes: Uint8Array): ContentBalance | null {
  const n = bytes.length;
  let depth = 0;
  let lowest = 0;
  let text = false;
  let path = false;
  let marked = 0;
  let nesting = 0;
  let image = false;
  let i = 0;
  while (i < n) {
    const c = bytes[i] as number;
    if (WHITESPACE.has(c)) {
      i += 1;
    } else if (c === 0x25) {
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i += 1;
    } else if (c === 0x28) {
      let level = 1;
      i += 1;
      while (i < n && level > 0) {
        const s = bytes[i] as number;
        if (s === 0x5c) {
          i += 2;
          continue;
        }
        if (s === 0x28) level += 1;
        else if (s === 0x29) level -= 1;
        i += 1;
      }
      if (level > 0) return null;
    } else if (c === 0x3c && bytes[i + 1] === 0x3c) {
      nesting += 1;
      i += 2;
    } else if (c === 0x3c) {
      const end = bytes.indexOf(0x3e, i + 1);
      if (end < 0) return null;
      i = end + 1;
    } else if (c === 0x3e && bytes[i + 1] === 0x3e) {
      nesting -= 1;
      i += 2;
    } else if (c === 0x5b) {
      nesting += 1;
      i += 1;
    } else if (c === 0x5d) {
      nesting -= 1;
      i += 1;
    } else if (c === 0x2f) {
      i += 1;
      while (i < n && regular(bytes[i] as number)) i += 1;
    } else if (!regular(c)) {
      i += 1;
    } else {
      const start = i;
      while (i < n && regular(bytes[i] as number)) i += 1;
      const token = String.fromCharCode(...bytes.subarray(start, Math.min(i, start + 3)));
      const length = i - start;
      if (!image && length <= 2 && PATH_BUILDING.has(token)) path = true;
      else if (!image && length <= 2 && PATH_ENDING.has(token)) path = false;
      if (image) {
        if (length === 2 && token === "ID") {
          // One whitespace byte, then binary data up to an EI between whitespace (or the end).
          let k = i + 1;
          for (; k + 1 < n; k += 1) {
            if (
              bytes[k] === 0x45 &&
              bytes[k + 1] === 0x49 &&
              WHITESPACE.has(bytes[k - 1] as number) &&
              (k + 2 === n || !regular(bytes[k + 2] as number))
            ) {
              break;
            }
          }
          if (k + 1 >= n) return null;
          i = k + 2;
          image = false;
        }
      } else if (length === 1 && token === "q") {
        depth += 1;
      } else if (length === 1 && token === "Q") {
        depth -= 1;
        lowest = Math.min(lowest, depth);
      } else if (length === 2 && token === "BT") {
        text = true;
      } else if (length === 2 && token === "ET") {
        text = false;
      } else if (length === 2 && token === "BI") {
        image = true;
      } else if (length === 3 && (token === "BMC" || token === "BDC")) {
        marked += 1;
      } else if (length === 3 && token === "EMC") {
        marked = Math.max(0, marked - 1);
      }
    }
  }
  if (image || nesting !== 0) return null;
  const saves = Math.abs(lowest);
  return { saves, restores: depth + saves, openText: text, openPath: path, openMarked: marked };
}

class TooLarge extends Error {}
class Unreadable extends Error {}

type Inflate = (input: Uint8Array, maxOutputLength: number) => Uint8Array;

/** A running allowance for inflated bytes of one kind, read from one file. */
class Budget {
  constructor(
    private readonly label: string,
    private left: number,
    private readonly limits: PdfWatermarkLimits,
    private readonly inflate: Inflate,
  ) {}

  get otherFilterBytes(): number {
    return this.limits.otherFilterBytes;
  }

  take(size: number): void {
    if (size > this.left || size > this.limits.streamBytes) {
      throw new TooLarge(`${this.label} over the limit`);
    }
    this.left -= size;
  }

  /** Inflates a Flate stream (trailing bytes ignored) within the allowance and the stream limit. */
  inflated(input: Uint8Array): Uint8Array {
    let out: Uint8Array;
    try {
      out = this.inflate(input, Math.min(this.left, this.limits.streamBytes) + 1);
    } catch (error) {
      if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
        throw new TooLarge(`${this.label} over the limit`);
      }
      throw new Unreadable(`flate: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.take(out.length);
    return out;
  }
}

/** The filter names of a stream dictionary written as text, in order. */
function filtersIn(dictionary: string): string[] {
  const match = /\/Filter\s*(\/[^\s/<>[\]()]+|\[[^\]]*\])/.exec(dictionary);
  return match ? (match[1]?.match(/\/[^\s/<>[\]()]+/g) ?? []).map((name) => name.slice(1)) : [];
}

const isFlate = (filters: readonly string[]) =>
  filters.length === 1 && (filters[0] === "FlateDecode" || filters[0] === "Fl");

/**
 * Object and cross-reference streams are the ones pdf-lib inflates while loading, with no limit, so
 * each is inflated here first against the budget. A stream under another filter must be small. A
 * stream that does not inflate (encrypted, or damaged) is left to pdf-lib, which refuses it or reads
 * no more of it than zlib could.
 */
function checkLoadStreams(bytes: Uint8Array, budget: Budget): void {
  const text = new TextDecoder("latin1").decode(bytes);
  for (const match of text.matchAll(/\/Type\s*\/(?:ObjStm|XRef)(?![^\s/<>[\]()])/g)) {
    let keyword = text.indexOf("stream", match.index);
    while (keyword > 2 && text.startsWith("end", keyword - 3)) {
      keyword = text.indexOf("stream", keyword + 6);
    }
    if (keyword < 0) continue;
    let start = keyword + 6;
    if (text[start] === "\r") start += 1;
    if (text[start] === "\n") start += 1;
    const opened = text.lastIndexOf(" obj", match.index);
    const filters = filtersIn(text.slice(Math.max(opened, match.index - 4096), keyword));
    if (filters.length === 0) continue;
    if (isFlate(filters)) {
      try {
        budget.inflated(bytes.subarray(start));
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
      }
      continue;
    }
    const end = text.indexOf("endstream", start);
    if ((end < 0 ? bytes.length : end) - start > budget.otherFilterBytes) {
      throw new TooLarge(`a ${filters.join("+")} stream over the limit`);
    }
  }
}

/** A page's content streams, decoded and joined the way a viewer reads them. */
function pageContent(page: PdfLibModule.PDFPage, lib: PdfLib, budget: Budget): Uint8Array | null {
  const contents = page.node.Contents();
  const items =
    contents === undefined
      ? []
      : contents instanceof lib.PDFArray
        ? contents.asArray().map((item) => page.doc.context.lookup(item))
        : [contents];
  const parts: Uint8Array[] = [];
  for (const item of items) {
    if (item instanceof lib.PDFContentStream) parts.push(item.getContents());
    else if (item instanceof lib.PDFRawStream) parts.push(decodeContent(item, lib, budget));
    else return null;
    // A stream boundary is a token boundary.
    parts.push(new Uint8Array([0x0a]));
  }
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

function decodeContent(stream: PdfLibModule.PDFRawStream, lib: PdfLib, budget: Budget): Uint8Array {
  const filter = stream.dict.lookup(lib.PDFName.of("Filter"));
  const filters =
    filter instanceof lib.PDFName
      ? [filter.decodeText()]
      : filter instanceof lib.PDFArray
        ? filter.asArray().map((name) => (name instanceof lib.PDFName ? name.decodeText() : "?"))
        : [];
  const params = stream.dict.lookup(lib.PDFName.of("DecodeParms"));
  if (filters.length === 0) return stream.contents;
  if (isFlate(filters) && params === undefined) return budget.inflated(stream.contents);
  if (stream.contents.length > budget.otherFilterBytes) {
    throw new TooLarge(`a ${filters.join("+")} content stream over the limit`);
  }
  const decoded = lib.decodePDFRawStream(stream).decode();
  budget.take(decoded.length);
  return decoded;
}

/**
 * Stamps `text` on every page of a PDF and answers the new file, or why it cannot be stamped: an
 * encrypted file (pdf-lib cannot rewrite one), one over the limits, or one that does not parse or
 * whose content cannot be closed safely.
 */
export async function stampPdfWatermark(
  bytes: Uint8Array,
  text: string,
  limits: PdfWatermarkLimits = PDF_WATERMARK_LIMITS,
): Promise<PdfWatermarkResult> {
  if (bytes.length > limits.bytes) return { ok: false, reason: "too-large", detail: "file size" };
  const lib = await import("pdf-lib");
  const zlib = await import("node:zlib");
  const inflate: Inflate = (input, maxOutputLength) =>
    zlib.inflateSync(input, { maxOutputLength, finishFlush: zlib.constants.Z_SYNC_FLUSH });
  const objects = new Budget("object streams", limits.objectBytes, limits, inflate);
  const content = new Budget("page content", limits.contentBytes, limits, inflate);
  try {
    checkLoadStreams(bytes, objects);
    // Loaded with ignoreEncryption only to ask: pdf-lib cannot write an encrypted file back.
    const doc = await lib.PDFDocument.load(bytes, {
      updateMetadata: false,
      ignoreEncryption: true,
    });
    if (doc.isEncrypted) return { ok: false, reason: "encrypted" };
    const pages = doc.getPages();
    if (pages.length === 0) return { ok: false, reason: "unreadable", detail: "no pages" };
    if (pages.length > limits.pages) return { ok: false, reason: "too-large", detail: "pages" };

    // A viewer shows an XFA form instead of the pages the line is drawn on.
    doc.catalog.lookupMaybe(lib.PDFName.of("AcroForm"), lib.PDFDict)?.delete(lib.PDFName.of("XFA"));
    doc.catalog.delete(lib.PDFName.of("NeedsRendering"));

    const font = await doc.embedFont(lib.StandardFonts.Helvetica);
    const glyphs = new Set(font.getCharacterSet());
    const value = printable(text.replace(/\s+/gu, " ").trim(), (cp) => glyphs.has(cp));
    const unit = Math.max(font.widthOfTextAtSize(value, 1), 1);
    const color = lib.grayscale(GRAY);

    for (const [index, page] of pages.entries()) {
      const own = pageContent(page, lib, content);
      const balance = own === null ? null : contentBalance(own);
      if (balance === null) {
        return { ok: false, reason: "unreadable", detail: `page ${index + 1} content` };
      }
      // pdf-lib wraps the page's content in q ... Q; the balance goes just inside that.
      page.node.normalize();
      const wrapped = page.node.Contents();
      if (wrapped instanceof lib.PDFArray && wrapped.size() >= 2) {
        const context = doc.context;
        const before = `\n${"q\n".repeat(balance.saves)}`;
        const closing = balance.openText ? "ET\n" : balance.openPath ? "n\n" : "";
        const after = `\n${closing}${"EMC\n".repeat(balance.openMarked)}${"Q\n".repeat(balance.restores)}`;
        wrapped.insert(1, context.register(context.stream(before)));
        wrapped.insert(wrapped.size() - 1, context.register(context.stream(after)));
      }

      const box = visibleBox(page.getMediaBox(), page.getCropBox());
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
  } catch (error) {
    if (error instanceof TooLarge) return { ok: false, reason: "too-large", detail: error.message };
    return {
      ok: false,
      reason: "unreadable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
