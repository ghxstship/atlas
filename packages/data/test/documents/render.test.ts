import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocumentModel } from "../../src/documents/generate.ts";
import { DOCUMENT_KINDS, type PrintSize } from "../../src/documents/model.ts";
import type { DocumentDataMap } from "../../src/documents/templates.ts";
import { qrMatrix } from "../../src/documents/qr.ts";
import { INTER_REGULAR_HEX } from "../../src/documents/fonts.generated.ts";
import {
  isEmbeddableImage,
  printable,
  renderDocumentPdf,
  renderDocumentsPdf,
  sfntFromWoff,
  streamDocumentsPdf,
} from "../../src/documents/render.ts";
import { BADGE_V2, BRAND, FIXTURES, LOGO_PNG, NOW, PHOTO_JPEG, PHOTO_PNG } from "./fixtures.ts";

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

describe("embedded fonts", () => {
  it("unwraps Inter's WOFF into the TrueType font it holds, every table intact", async () => {
    const woff = Buffer.from(INTER_REGULAR_HEX, "hex");
    const font = await sfntFromWoff(woff);
    const count = font.readUInt16BE(4);
    expect(font.readUInt32BE(0)).toBe(woff.readUInt32BE(4));
    expect(count).toBe(woff.readUInt16BE(12));
    for (let i = 0; i < count; i++) {
      const tag = font.toString("latin1", 12 + 16 * i, 16 + 16 * i);
      const offset = font.readUInt32BE(20 + 16 * i);
      const table = Buffer.from(font.subarray(offset, offset + font.readUInt32BE(24 + 16 * i)));
      // The checksum WOFF keeps is the uncompressed table's; head's skips checkSumAdjustment.
      if (tag === "head") table.writeUInt32BE(0, 8);
      const words = Buffer.concat([table, Buffer.alloc(3)]);
      let sum = 0;
      for (let at = 0; at < table.length; at += 4) sum = (sum + words.readUInt32BE(at)) >>> 0;
      expect([tag, sum]).toEqual([tag, font.readUInt32BE(16 + 16 * i)]);
      expect(offset % 4).toBe(0);
    }
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

describe("credential badges on cards and in batches (P5)", () => {
  const ascii: DocumentDataMap["credential-badge"] = {
    ...BADGE_V2,
    credential: { ...BADGE_V2.credential, holderName: "Ana Ruiz" },
  };
  // No logo, so the only image in a file is the portrait.
  const model = (paper: PrintSize, data: DocumentDataMap["credential-badge"] = ascii) =>
    buildDocumentModel("credential-badge", data, {
      locale: "en-US",
      messages: EN,
      brand: { ...BRAND, logo: null },
      recordUrl: "https://atlas.example.test/r",
      now: NOW,
      paper,
    });
  const pages = (pdf: string) => (pdf.match(/\/Type \/Page\b(?!s)/g) ?? []).length;

  /** A real JPEG grown to `size` bytes with comment segments, as a camera photo of that size would be. */
  function jpegOf(size: number): Uint8Array {
    const parts: Uint8Array[] = [PHOTO_JPEG.subarray(0, 2)];
    let total = PHOTO_JPEG.length;
    while (total < size) {
      const n = Math.min(65_000, size - total);
      const segment = new Uint8Array(n + 4);
      segment.set([0xff, 0xfe, ((n + 2) >> 8) & 0xff, (n + 2) & 0xff]);
      parts.push(segment);
      total += segment.length;
    }
    parts.push(PHOTO_JPEG.subarray(2));
    return Uint8Array.from(Buffer.concat(parts));
  }

  it("draws the CR80 card and A6 page boxes, one page each", async () => {
    const cr80 = text(await renderDocumentPdf(model("cr80"), { paper: "cr80" }));
    expect(cr80).toContain("/MediaBox [0 0 153.01 242.65]");
    expect(pages(cr80)).toBe(1);
    const a6 = text(await renderDocumentPdf(model("a6"), { paper: "a6" }));
    expect(a6).toContain("/MediaBox [0 0 297.64 419.53]");
    expect(pages(a6)).toBe(1);
  }, 60_000);

  it("tags the portrait and the gate code as Figures with alternative text, and the name as the heading", async () => {
    for (const paper of ["cr80", "a6", "letter"] as const) {
      const pdf = text(await renderDocumentPdf(model(paper), { paper }));
      expect(pdf).toContain("/Alt (Photo of Ana Ruiz, the credential holder)");
      expect(pdf).toContain("/Alt (Entry code for credential CR-000042)");
      expect(pdf).toContain("/Subtype /Image");
      expect(pdf).toContain("pdfuaid:part>1<");
    }
    const card = text(await renderDocumentPdf(model("cr80"), { paper: "cr80" }));
    expect(card).toContain("/S /H1");
    // The only QR on a card is the gate code: the record link is not drawn there.
    expect(card).not.toContain("QR code that opens record");
    const page = text(await renderDocumentPdf(model("letter"), { paper: "letter" }));
    expect(page).toContain("QR code that opens record");
    const a6 = text(await renderDocumentPdf(model("a6"), { paper: "a6" }));
    expect(a6).toContain("/S /Table");
    expect(card).not.toContain("/S /Table");
  }, 60_000);

  it("prints the placeholder for a missing photo or one it cannot embed", async () => {
    for (const bytes of [null, new TextEncoder().encode("RIFF....WEBP")]) {
      const data = { ...ascii, photo: bytes ? { bytes, source: "Profile" as const } : null };
      const pdf = text(await renderDocumentPdf(model("cr80", data), { paper: "cr80" }));
      expect(pdf).not.toContain("/Subtype /Image");
      expect(pdf).not.toContain("/Alt (Photo of Ana Ruiz");
    }
    const png = { ...ascii, photo: { bytes: PHOTO_PNG, source: "Badge" as const } };
    expect(text(await renderDocumentPdf(model("a6", png), { paper: "a6" }))).toContain(
      "/Subtype /Image",
    );
  }, 60_000);

  it("wraps a long name on the card and keeps it to one card", async () => {
    const pdf = text(await renderDocumentPdf(model("cr80", BADGE_V2), { paper: "cr80" }));
    expect(pages(pdf)).toBe(1);
  }, 60_000);

  it("refuses a card paper for any kind but the badge", async () => {
    const invoice = buildDocumentModel("invoice", FIXTURES.invoice, {
      locale: "en-US",
      messages: EN,
      brand: BRAND,
      recordUrl: "u",
      now: NOW,
    });
    await expect(renderDocumentPdf(invoice, { paper: "cr80" })).rejects.toThrow(/Letter or A4/);
  });

  it("puts a batch of three in one file, a Sect per badge with its own facts", async () => {
    const three = ["CR-000001", "CR-000002", "CR-000003"].map((number) =>
      model("cr80", { ...ascii, credential: { ...ascii.credential, number } }),
    );
    const pdf = text(
      await renderDocumentsPdf(three, {
        paper: "cr80",
        title: "Credential badges (3)",
        lang: "en-US",
      }),
    );
    expect(pages(pdf)).toBe(3);
    expect((pdf.match(/\/S \/Sect\b/g) ?? []).length).toBe(3);
    expect((pdf.match(/\/S \/Document\b/g) ?? []).length).toBe(1);
    for (const number of ["CR-000001", "CR-000002", "CR-000003"]) {
      expect(pdf).toContain(`/Alt (Entry code for credential ${number})`);
    }
    expect(pdf).toContain("(Credential badges \\(3\\))");
    const letter = text(
      await renderDocumentsPdf(
        three.map((m, i) =>
          model("letter", {
            ...ascii,
            credential: { ...ascii.credential, number: `CR-00000${i + 1}` },
          }),
        ),
        { paper: "letter", title: "Credential badges (3)", lang: "en-US" },
      ),
    );
    expect(pages(letter)).toBe(3);
  }, 60_000);

  it("streams a 100-badge batch with 150 KB photos as it draws them", async () => {
    const photo = jpegOf(150 * 1024);
    expect(photo.length).toBeGreaterThanOrEqual(150 * 1024);
    const hundred = Array.from({ length: 100 }, (_, i) =>
      model("cr80", {
        ...ascii,
        credential: { ...ascii.credential, number: `CR-${String(i + 1).padStart(6, "0")}` },
        photo: { bytes: photo, source: "Badge" },
      }),
    );
    const reader = streamDocumentsPdf(hundred, {
      paper: "cr80",
      title: "Credential badges (100)",
      lang: "en-US",
    }).getReader();
    let chunks = 0;
    let bytes = 0;
    let firstAt = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      bytes += value.length;
      if (firstAt < 0 && bytes > 1024 * 1024) firstAt = chunks;
    }
    expect(bytes).toBeGreaterThan(100 * 150 * 1024);
    // More than a megabyte has gone out long before the hundredth badge is drawn.
    expect(chunks).toBeGreaterThan(firstAt);
    expect(firstAt).toBeGreaterThan(0);
    await expect(
      renderDocumentsPdf([...hundred, hundred[0] as never], {
        paper: "cr80",
        title: "x",
        lang: "en-US",
      }),
    ).rejects.toThrow(/1 to 100/);
  }, 120_000);
});
