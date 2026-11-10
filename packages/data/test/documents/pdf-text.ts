import type { PDFDict } from "pdf-lib";
import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef } from "pdf-lib";

/**
 * The text a rendered PDF actually shows, read from its content streams through each font's ToUnicode
 * map, so a test sees what a reader extracts and not what the model meant to print.
 */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const resolve = (o: unknown) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
  const decoded = (stream: PDFRawStream) =>
    Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");

  const pages: string[] = [];
  for (const page of doc.getPages()) {
    const fonts = new Map<string, Map<string, string>>();
    const fontDict = page.node.Resources()?.get(PDFName.of("Font"));
    const dict = resolve(fontDict) as PDFDict | undefined;
    for (const [name, ref] of dict?.entries() ?? []) {
      const font = resolve(ref) as PDFDict;
      const cmap = resolve(font.get(PDFName.of("ToUnicode")));
      if (cmap instanceof PDFRawStream) fonts.set(name.decodeText(), toUnicodeMap(decoded(cmap)));
    }
    const contents = resolve(page.node.Contents());
    const streams =
      contents instanceof PDFArray ? contents.asArray().map((c) => resolve(c)) : [contents];
    const source = streams
      .filter((s): s is PDFRawStream => s instanceof PDFRawStream)
      .map(decoded)
      .join("\n");
    let map = new Map<string, string>();
    let text = "";
    for (const op of source.matchAll(
      /\/([A-Za-z0-9+_-]+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g,
    )) {
      if (op[1]) map = fonts.get(op[1]) ?? new Map();
      else {
        for (const hex of (op[2] ?? `<${op[3] ?? ""}>`).matchAll(/<([0-9a-fA-F]+)>/g)) {
          const codes = hex[1] ?? "";
          const width = map.keys().next().value?.length ?? 4;
          for (let i = 0; i < codes.length; i += width) {
            text += map.get(codes.slice(i, i + width).toLowerCase()) ?? "";
          }
        }
        text += " ";
      }
    }
    pages.push(text);
  }
  return pages.join("\n");
}

/** A ToUnicode CMap's beginbfchar and beginbfrange entries, keyed by lowercase hex code. */
function toUnicodeMap(cmap: string): Map<string, string> {
  const map = new Map<string, string>();
  const unicode = (hex: string) =>
    String.fromCodePoint(...(hex.match(/.{4}/g) ?? []).map((u) => Number.parseInt(u, 16)));
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const entry of (block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set((entry[1] ?? "").toLowerCase(), unicode(entry[2] ?? ""));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const entry of (block[1] ?? "").matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g,
    )) {
      const low = entry[1] ?? "";
      const start = Number.parseInt(low, 16);
      const end = Number.parseInt(entry[2] ?? "", 16);
      const list = [...(entry[4] ?? "").matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => m[1] ?? "");
      for (let code = start; code <= end; code += 1) {
        const key = code.toString(16).padStart(low.length, "0");
        const target = entry[3]
          ? (Number.parseInt(entry[3], 16) + code - start).toString(16).padStart(4, "0")
          : (list[code - start] ?? "");
        map.set(key, unicode(target));
      }
    }
  }
  return map;
}
