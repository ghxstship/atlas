import { EXTERNAL_DOCUMENT_KINDS } from "@xos/data/documents/sources-external";
import { describe, expect, it } from "vitest";
import { documentHref, gatewayRecordPath, signsInOneClick } from "@/lib/documents/links";

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

  it("never lets a Quote be signed in one click, in any state", () => {
    for (const state of ["Proposed", "Sent", "Signed", "Executed"]) {
      expect(signsInOneClick({ kind: "Quote", state })).toBe(false);
    }
    expect(signsInOneClick({ kind: "Agreement", state: "Sent" })).toBe(true);
    expect(signsInOneClick({ kind: "Agreement", state: "Signed" })).toBe(false);
  });

  it("never lets a generated agreement be signed in one click (B10)", () => {
    expect(signsInOneClick({ kind: "Agreement", state: "Sent", generated: true })).toBe(false);
    expect(signsInOneClick({ kind: "Agreement", state: "Sent", generated: false })).toBe(true);
  });
});
