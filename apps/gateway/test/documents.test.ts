import { EXTERNAL_DOCUMENT_KINDS } from "@xos/data/documents/sources-external";
import { describe, expect, it } from "vitest";
import { documentHref, gatewayRecordPath } from "@/lib/documents/links";

describe("Gateway document links (Section 11.9)", () => {
  it("carries the engagement so the QR code opens the tab", () => {
    expect(documentHref("invoice", "i 1", "ENG-7")).toBe(
      "/documents/invoice/i%201?engagement=ENG-7",
    );
  });

  it.each(EXTERNAL_DOCUMENT_KINDS)("links %s back to its engagement tab", (kind) => {
    const path = gatewayRecordPath(kind, "ENG-7");
    expect(path).toContain("/work/engagements/ENG-7/");
    expect(path).not.toContain("{engagementKey}");
  });

  it("falls back to Work without an engagement", () => {
    expect(gatewayRecordPath("credential-badge", null)).toBe("/work");
  });
});
