import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildDocumentModel,
  renderSharedImagePdf,
  sharedImageModel,
  watermarkText,
  watermarkedFileName,
} from "../../src/documents/generate.ts";
import {
  COMPLIANCE_DOCUMENT_KINDS,
  DOCUMENT_CLASSIFICATION,
  DOCUMENT_KINDS,
  needsWatermark,
} from "../../src/documents/model.ts";
import { renderDocumentPdf } from "../../src/documents/render.ts";
import { BRAND, FIXTURES, LOGO_PNG, NOW } from "./fixtures.ts";

/**
 * Section 8.6 watermarks (finding A65-016): Confidential and Restricted PDFs and images carry the
 * viewer's email and the time, in the reading order once and across every page as an artifact.
 */
const catalog = (locale: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../i18n/messages/${locale}/documents.json`, import.meta.url),
      "utf8",
    ),
  );
const EN = catalog("en-US");
const ES = catalog("es-US");
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("document classification", () => {
  it("classifies every record document and compliance form", () => {
    for (const kind of [...DOCUMENT_KINDS, ...COMPLIANCE_DOCUMENT_KINDS]) {
      expect(DOCUMENT_CLASSIFICATION[kind]).toMatch(/^(Public|Internal|Confidential|Restricted)$/);
    }
  });

  it("watermarks Confidential and Restricted documents only", () => {
    expect(needsWatermark("Public")).toBe(false);
    expect(needsWatermark("Internal")).toBe(false);
    expect(needsWatermark("Confidential")).toBe(true);
    expect(needsWatermark("Restricted")).toBe(true);
    expect(DOCUMENT_CLASSIFICATION["certified-payroll"]).toBe("Restricted");
    expect(DOCUMENT_CLASSIFICATION["osha-301"]).toBe("Confidential");
    expect(DOCUMENT_CLASSIFICATION["purchase-order"]).toBe("Internal");
  });
});

describe("watermark text", () => {
  it("names the viewer and the time, with the time zone", () => {
    expect(watermarkText(EN, "en-US", "ana@venue.test", NOW)).toBe(
      "Downloaded by ana@venue.test on Oct 19, 2026, 3:30 PM UTC",
    );
    expect(watermarkText(ES, "es-US", "ana@venue.test", NOW, "America/New_York")).toMatch(
      /^Descargado por ana@venue\.test el 19 oct 2026, .+$/,
    );
  });

  it("keeps a safe download name", () => {
    expect(watermarkedFileName("Stage plot (v2).png")).toBe("Stage-plot-v2-watermarked.pdf");
    expect(watermarkedFileName("???.jpg")).toBe("shared-image-watermarked.pdf");
  });
});

describe("watermarked PDFs", () => {
  it("prints the viewer and time on a Confidential document", async () => {
    const watermark = watermarkText(EN, "en-US", "carol@northwind.test", NOW);
    const model = buildDocumentModel("incident-report", FIXTURES["incident-report"], {
      locale: "en-US",
      messages: EN,
      brand: BRAND,
      recordUrl: "https://atlas.example.test/r",
      now: NOW,
      watermark,
    });
    expect(model.watermark?.text).toBe(watermark);
    const pdf = text(await renderDocumentPdf(model, { paper: "letter" }));
    expect(pdf).toContain(`<pdf:Keywords>${watermark}</pdf:Keywords>`);
    // The page-wide copy is drawn at reduced opacity through an extended graphics state.
    expect(pdf).toMatch(/\/ca 0\.16/);
    expect(pdf).toContain("/StructTreeRoot");
  }, 60_000);

  it("leaves an Internal document unmarked", async () => {
    const model = buildDocumentModel("purchase-order", FIXTURES["purchase-order"], {
      locale: "en-US",
      messages: EN,
      brand: BRAND,
      recordUrl: "u",
      now: NOW,
    });
    expect(model.watermark).toBeUndefined();
    const pdf = text(await renderDocumentPdf(model, { paper: "letter" }));
    expect(pdf).not.toContain("pdf:Keywords");
  }, 60_000);

  it("delivers a Confidential image as a tagged, watermarked PDF", async () => {
    const input = {
      bytes: LOGO_PNG,
      filename: "stage.png",
      orgName: "Northwind Live",
      locale: "en-US",
      messages: EN,
      sourceUrl: "https://atlas.example.test/share/xshr_test",
      watermark: watermarkText(EN, "en-US", "ana@venue.test", NOW),
      now: NOW,
    };
    const model = sharedImageModel(input);
    expect(model.blocks[0]).toMatchObject({
      kind: "image",
      alt: "stage.png, shared by Northwind Live",
    });
    const out = await renderSharedImagePdf(input);
    expect(out.fileName).toBe("stage-watermarked.pdf");
    const pdf = text(out.bytes);
    expect(pdf).toContain("/S /Figure");
    expect(pdf).toContain("/Alt (stage.png, shared by Northwind Live)");
    expect(pdf).toContain(
      "<pdf:Keywords>Downloaded by ana@venue.test on Oct 19, 2026, 3:30 PM UTC</pdf:Keywords>",
    );
  }, 60_000);

  it("prints wide forms in landscape", async () => {
    const model = buildDocumentModel("day-sheet", FIXTURES["day-sheet"], {
      locale: "en-US",
      messages: EN,
      brand: { ...BRAND, logo: null },
      recordUrl: "u",
      now: NOW,
    });
    const pdf = text(await renderDocumentPdf(model, { paper: "letter", orientation: "landscape" }));
    expect(pdf).toMatch(/\/MediaBox \[0 0 792 612\]/);
  }, 60_000);
});
