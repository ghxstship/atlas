import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { gatewayLegalDocument } from "../lib/auth/legal";
import { LEGAL_LINK_DOCUMENTS, legalLinks, servesLegalPage } from "../lib/legal-links";

/**
 * The public legal links (RRR-248) on Gateway's sign-in page link only pages Gateway's
 * /legal/[document] serves: a document in GATEWAY_LEGAL_DOCUMENTS, or Cookie settings. Gateway
 * links the Consumer Health Data Privacy Policy from its front door as Atlas's homepage does, so
 * once legal/index.yaml publishes that policy this fails until Gateway publishes it too.
 */
const registry = (
  parse(readFileSync(new URL("../../../legal/index.yaml", import.meta.url), "utf8")) as {
    documents: { slug: string; publish: string }[];
  }
).documents;
const HEALTH_DATA = "consumer-health-data-privacy-policy";

describe("Gateway's public legal links", () => {
  it("links every listed document Gateway serves, and nothing else", () => {
    const expected = LEGAL_LINK_DOCUMENTS.filter(
      (d) => d.slug === "cookie-settings" || gatewayLegalDocument(d.slug) !== undefined,
    ).map((d) => `/legal/${d.slug}`);
    expect(legalLinks().map((l) => l.href)).toEqual(expected);
    for (const { href } of legalLinks()) {
      expect(servesLegalPage(href.slice("/legal/".length)), href).toBe(true);
    }
    expect(servesLegalPage("no-such-document")).toBe(false);
  });

  it("always carries the Privacy Policy, the Worker Terms and Cookie settings", () => {
    expect(legalLinks().map((l) => l.key)).toEqual(
      expect.arrayContaining(["privacy", "workerTerms", "cookies"]),
    );
  });

  it("publishes the Consumer Health Data Privacy Policy once the registry does", () => {
    const inRegistry = registry.some((d) => d.slug === HEALTH_DATA && d.publish === "public");
    expect(servesLegalPage(HEALTH_DATA)).toBe(inRegistry);
  });
});
