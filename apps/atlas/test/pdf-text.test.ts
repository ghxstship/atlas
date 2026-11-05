import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocumentModel } from "@xos/data/documents/generate";
import { renderDocumentPdf } from "@xos/data/documents/render";
import { pdfText } from "./fixtures/pdf";

/**
 * The PDF text reader the R7 journey uses on the radio hand-out (e2e/r7-allocations.spec.ts), checked here on a
 * hand-out rendered by the documents pipeline itself: names, tags and channels read back through the embedded
 * fonts' ToUnicode maps.
 */

const EN: unknown = JSON.parse(
  readFileSync(
    new URL("../../../packages/i18n/messages/en-US/documents.json", import.meta.url),
    "utf8",
  ),
);

describe("pdfText", () => {
  it("reads a rendered radio hand-out's people, tags and channels", async () => {
    const model = buildDocumentModel(
      "radio-handout",
      {
        project: {
          id: "00000000-0000-4000-8000-000000000001",
          key: "NWF26",
          name: "Northwind Festival 2026",
          timeZone: "America/New_York",
        },
        lines: [
          {
            allocationId: "a1000000-0000-4000-8000-000000000001",
            rosterEntryId: "re1",
            personName: "Kai Morgan",
            partyName: "Bayside Audio",
            className: "Two-way radios",
            quantity: 2,
            tagsIssued: ["R7AB1", "R7AB2"],
            channelNumbers: [1, 3],
            channelNames: ["Production", "Stage"],
            status: "Issued",
          },
        ],
      },
      {
        locale: "en-US",
        messages: EN,
        brand: { name: "Northwind Live", legalEntity: null, accentHex: "#3b5bdb", logo: null },
        recordUrl: "https://atlas.example.test/r",
        now: new Date("2026-10-19T15:30:00Z"),
      },
    );
    const text = pdfText(
      await renderDocumentPdf(model, { paper: "letter", orientation: "landscape" }),
    );
    expect(text).toContain("Kai Morgan");
    expect(text).toContain("Bayside Audio");
    expect(text).toContain("R7AB1");
    expect(text).toContain("R7AB2");
    expect(text).toContain("Production");
    expect(text).toContain("Stage");
    expect(text).toContain("Tags issued");
  });
});
