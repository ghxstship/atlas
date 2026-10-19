import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocumentModel } from "../../src/documents/generate.ts";
import { DOCUMENT_KINDS } from "../../src/documents/model.ts";
import { qrMatrix } from "../../src/documents/qr.ts";
import { isEmbeddableImage, printable, renderDocumentPdf } from "../../src/documents/render.ts";
import { BRAND, FIXTURES, LOGO_PNG, NOW } from "./fixtures.ts";

const EN: unknown = JSON.parse(
  readFileSync(new URL("../../../i18n/messages/en-US/documents.json", import.meta.url), "utf8"),
);

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("printable text", () => {
  const latin = (cp: number) => cp < 0x250 && cp !== 0x142;

  it("keeps what the font draws and folds the rest to a base letter or a question mark", () => {
    expect(printable("Año ñ é", latin)).toBe("Año ñ é");
    expect(printable("Łódź ł", (cp) => cp < 0x80 || cp === 0xf3)).toBe("?ódz ?");
    expect(printable("漢字", latin)).toBe("??");
  });

  it("drops control characters, keeps line breaks and turns tabs into spaces", () => {
    expect(printable("a\tb\r\nc\u0007d\u0085", latin)).toBe("a b\ncd");
  });
});

describe("images and QR codes", () => {
  it("embeds only PNG and JPEG logos", () => {
    expect(isEmbeddableImage(LOGO_PNG)).toBe(true);
    expect(isEmbeddableImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isEmbeddableImage(new TextEncoder().encode("<svg/>"))).toBe(false);
  });

  it("encodes the record link as a square matrix", () => {
    const m = qrMatrix("https://atlas.example.test/org/procurement/purchase-orders?peek=1");
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.every((row) => row.length === m.length)).toBe(true);
    // Finder pattern corner.
    expect(m[0]?.[0]).toBe(true);
  });
});

describe("tagged PDF/UA output", () => {
  it.each(DOCUMENT_KINDS)(
    "%s renders a tagged PDF/UA-1 file",
    async (kind) => {
      const model = buildDocumentModel(kind, FIXTURES[kind] as never, {
        locale: "en-US",
        messages: EN,
        brand: BRAND,
        recordUrl: "https://atlas.example.test/r",
        now: NOW,
      });
      const pdf = text(
        await renderDocumentPdf(model, { paper: kind.length % 2 ? "a4" : "letter" }),
      );
      expect(pdf.startsWith("%PDF-1.7")).toBe(true);
      expect(pdf).toContain("/StructTreeRoot");
      expect(pdf).toContain("/MarkInfo");
      expect(pdf).toMatch(/\/Lang \(en-US\)/);
      expect(pdf).toContain("/DisplayDocTitle true");
      expect(pdf).toContain("pdfuaid:part>1<");
      expect(pdf).toContain("/FontFile2");
      // The PDF/A-only CIDSet that veraPDF refuses under PDF/UA (render.ts).
      expect(pdf).not.toContain("/CIDSet");
      expect(pdf).not.toMatch(/\/BaseFont \/Helvetica/);
    },
    // The first render loads and subsets the fonts, which takes longer on a loaded machine or CI.
    60_000,
  );

  it("draws A4 and Letter page sizes", async () => {
    const model = buildDocumentModel("day-sheet", FIXTURES["day-sheet"], {
      locale: "en-US",
      messages: EN,
      brand: { ...BRAND, logo: null, accentHex: "not a color" },
      recordUrl: "u",
      now: NOW,
    });
    expect(text(await renderDocumentPdf(model, { paper: "a4" }))).toContain(
      "/MediaBox [0 0 595.28 841.89]",
    );
    expect(text(await renderDocumentPdf(model, { paper: "letter" }))).toContain(
      "/MediaBox [0 0 612 792]",
    );
  }, 60_000);
});
