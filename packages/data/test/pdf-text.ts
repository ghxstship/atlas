import { inflateSync } from "node:zlib";

/**
 * The text pdfkit drew on each page of a PDF, for tests: every content stream inflated and the strings of its
 * TJ operators decoded (pdfkit writes Helvetica text as hex WinAnsi codes, split where kerning applies). pdfkit
 * writes one content stream per page and no other stream for the standard fonts, so the result has one entry
 * per page, in page order.
 */
export function pdfPageTexts(bytes: Uint8Array): string[] {
  const raw = Buffer.from(bytes);
  const latin = raw.toString("latin1");
  const pages: string[] = [];
  const header = /<<([^]*?)>>\s*stream\r?\n/g;
  for (let match = header.exec(latin); match !== null; match = header.exec(latin)) {
    const dict = match[1] ?? "";
    const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? "NaN");
    if (!Number.isFinite(length)) continue;
    const start = match.index + match[0].length;
    const body = raw.subarray(start, start + length);
    const content = (dict.includes("/FlateDecode") ? inflateSync(body) : body).toString("latin1");
    if (!/\bTJ\b|\bTj\b/.test(content)) continue;
    const lines: string[] = [];
    for (const op of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      const hex = [...(op[1] ?? "").matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1] ?? "").join("");
      lines.push(Buffer.from(hex, "hex").toString("latin1"));
    }
    pages.push(lines.join("\n"));
    header.lastIndex = start + length;
  }
  return pages;
}

/** Pages of a PDF, from its page objects. */
export function pdfPageCount(bytes: Uint8Array): number {
  return [
    ...Buffer.from(bytes)
      .toString("latin1")
      .matchAll(/\/Type \/Page\b(?!s)/g),
  ].length;
}
