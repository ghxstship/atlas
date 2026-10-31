import { inflateSync } from "node:zlib";

/**
 * PDF fixtures shared by the copyForViewer unit tests and the A103 journey (Section 8.6, finding
 * A65-016): a hand-built two-page upload, and the readers that find the watermark in a delivered copy.
 */

/**
 * Two letter pages, each drawing its own line. pdf-lib reads the objects, not the offsets. With
 * `encrypted`, the trailer names a Standard security handler, as an owner-password PDF's does.
 */
export function twoPagePdf(options: { readonly encrypted?: boolean } = {}): Uint8Array {
  const page = (n: number) => `BT /F1 18 Tf 72 700 Td (Rider page ${n}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${page(1).length} >>\nstream\n${page(1)}\nendstream`,
    `<< /Length ${page(2).length} >>\nstream\n${page(2)}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>",
    ...(options.encrypted ? ["<< /Filter /Standard /V 2 /R 3 /Length 128 >>"] : []),
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  const encrypt = options.encrypted ? ` /Encrypt ${objects.length} 0 R` : "";
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypt} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** The content of every stream in a PDF, inflated when compressed, lowercased. */
export function pdfStreams(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  for (const m of text.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const raw = Buffer.from(m[1] ?? "", "latin1");
    try {
      out.push(inflateSync(raw).toString("latin1"));
    } catch {
      out.push(raw.toString("latin1"));
    }
  }
  return out.join("\n").toLowerCase();
}

/** Helvetica draws the watermark as a hex string of its character codes (lowercase, as pdfStreams). */
export const hexText = (text: string): string =>
  [...text].map((c) => (c.codePointAt(0) ?? 0).toString(16).padStart(2, "0")).join("");

/** How many times a line is drawn in a delivered PDF, and its page count. */
export function watermarks(bytes: Uint8Array, line: string): { marks: number; pages: number } {
  const text = Buffer.from(bytes).toString("latin1");
  return {
    marks: pdfStreams(bytes).split(hexText(line).toLowerCase()).length - 1,
    pages: (text.match(/\/Type \/Page\b(?!s)/g) ?? []).length,
  };
}

/** Every object of a PDF by number, with its stream inflated when it has one. */
function pdfObjects(bytes: Uint8Array): Map<number, { dict: string; stream: string | null }> {
  const text = Buffer.from(bytes).toString("latin1");
  const out = new Map<number, { dict: string; stream: string | null }>();
  for (const m of text.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    const body = m[2] ?? "";
    const s = /^([\s\S]*?)stream\r?\n([\s\S]*?)\r?\nendstream/.exec(body);
    let stream: string | null = null;
    if (s) {
      const raw = Buffer.from(s[2] ?? "", "latin1");
      try {
        stream = inflateSync(raw).toString("latin1");
      } catch {
        stream = raw.toString("latin1");
      }
    }
    out.set(Number(m[1]), { dict: s ? (s[1] ?? "") : body, stream });
  }
  return out;
}

/** A ToUnicode CMap as glyph code to text, from its bfchar and bfrange sections. */
function toUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const utf16 = (hex: string) =>
    String.fromCharCode(...(hex.match(/.{1,4}/g) ?? []).map((h) => parseInt(h, 16)));
  for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of (section[1] ?? "").matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(p[1] ?? "0", 16), utf16(p[2] ?? ""));
    }
  }
  for (const section of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = section[1] ?? "";
    for (const r of body.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g,
    )) {
      const start = parseInt(r[1] ?? "0", 16);
      const end = parseInt(r[2] ?? "0", 16);
      const target = r[3] ?? "";
      if (target.startsWith("[")) {
        [...target.matchAll(/<([0-9a-fA-F]+)>/g)].forEach((t, i) =>
          map.set(start + i, utf16(t[1] ?? "")),
        );
      } else {
        const first = parseInt(target.slice(1, -1), 16);
        for (let code = start; code <= end; code++)
          map.set(code, String.fromCharCode(first + code - start));
      }
    }
  }
  return map;
}

/**
 * The text a rendered document draws, in drawing order, through each embedded font's ToUnicode map (pdfkit writes
 * glyph ids as four hex digits). Each text object ends with a space, so cells and lines stay apart; runs of white
 * space are folded to one.
 */
export function pdfText(bytes: Uint8Array): string {
  const objects = pdfObjects(bytes);
  const fonts = new Map<string, Map<number, string>>();
  for (const { dict } of objects.values()) {
    for (const block of dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
      for (const ref of (block[1] ?? "").matchAll(/\/([A-Za-z0-9]+)\s+(\d+) 0 R/g)) {
        const font = objects.get(Number(ref[2]));
        const cmapRef = /\/ToUnicode\s+(\d+) 0 R/.exec(font?.dict ?? "");
        const cmap = cmapRef ? objects.get(Number(cmapRef[1]))?.stream : null;
        if (cmap) fonts.set(ref[1] ?? "", toUnicode(cmap));
      }
    }
  }
  let out = "";
  for (const { stream } of objects.values()) {
    if (!stream || !/\bTf\b/.test(stream)) continue;
    let font: Map<number, string> | undefined;
    for (const op of stream.matchAll(
      /\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf|\[((?:[^\]\\]|\\.)*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj|\bET\b/g,
    )) {
      if (op[1] !== undefined) {
        font = fonts.get(op[1]);
      } else if (op[0] === "ET") {
        out += " ";
      } else {
        const hex =
          op[2] !== undefined
            ? [...op[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1] ?? "").join("")
            : (op[3] ?? "");
        for (const code of hex.match(/.{4}/g) ?? []) out += font?.get(parseInt(code, 16)) ?? "";
      }
    }
  }
  return out.replace(/\s+/g, " ").trim();
}
