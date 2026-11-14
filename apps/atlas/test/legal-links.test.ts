import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  LEGAL_LINK_DOCUMENTS,
  legalLinks,
  servesLegalPage,
  SMS_CONSENT_LINKS,
} from "@/lib/legal-links";

/**
 * The public legal links (RRR-248) link only pages Atlas's /legal/[document] serves: a document
 * legal/index.yaml publishes as public, or Cookie settings. A document the registry does not
 * publish yet stays out of the footer, so no link 404s, and it appears once the registry has it.
 */
const registry = (
  parse(readFileSync(new URL("../../../legal/index.yaml", import.meta.url), "utf8")) as {
    documents: { slug: string; publish: string }[];
  }
).documents;
const published = new Set(registry.filter((d) => d.publish === "public").map((d) => d.slug));

describe("public legal links", () => {
  it("links every listed document the registry publishes, and nothing else", () => {
    const expected = LEGAL_LINK_DOCUMENTS.filter(
      (d) => d.slug === "cookie-settings" || published.has(d.slug),
    ).map((d) => `/legal/${d.slug}`);
    expect(legalLinks().map((l) => l.href)).toEqual(expected);
    for (const { href } of legalLinks()) {
      expect(servesLegalPage(href.slice("/legal/".length)), href).toBe(true);
    }
  });

  it("always carries the Privacy Policy, the Terms of Service, Cookie settings and Contact", () => {
    expect(legalLinks().map((l) => l.key)).toEqual(
      expect.arrayContaining(["privacy", "terms", "cookies", "contact"]),
    );
  });

  it("carries the Consumer Health Data Privacy Policy exactly when the registry publishes it", () => {
    const linked = legalLinks().some((l) => l.key === "healthData");
    expect(linked).toBe(published.has("consumer-health-data-privacy-policy"));
  });

  it("never serves an internal document or an unknown slug", () => {
    expect(servesLegalPage("compliance-matrix")).toBe(false);
    expect(servesLegalPage("no-such-document")).toBe(false);
  });
});

describe("the consent to texts links", () => {
  it("links the Text Message Terms and the Privacy Policy's text message section, both served", () => {
    expect(SMS_CONSENT_LINKS).toEqual({
      terms: "/legal/text-message-terms",
      privacy: "/legal/privacy-policy#section-17",
    });
    expect(servesLegalPage("text-message-terms")).toBe(true);
    expect(servesLegalPage("privacy-policy")).toBe(true);
  });

  it("points the privacy link at the section headed Text Messages", () => {
    const policy = readFileSync(
      new URL("../../../legal/privacy-policy.md", import.meta.url),
      "utf8",
    );
    expect(policy).toMatch(/^## 17\. Text Messages$/m);
  });
});
