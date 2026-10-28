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
