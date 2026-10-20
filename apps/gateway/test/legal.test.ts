import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  clientIp,
  GATEWAY_LEGAL_DOCUMENTS,
  gatewayLegalDocument,
  PENDING_ACCEPTANCES,
  pendingAcceptances,
  signUpAcceptances,
} from "../lib/auth/legal";

/**
 * Gateway account creation and the legal registry (Section 14.4, finding A59-025): the documents
 * sign-up names match legal/index.yaml, so a new version there fails here until Gateway follows.
 */
interface RegistryDocument {
  slug: string;
  title: string;
  version: string;
  publish: string;
  requires_acceptance_at_signup: boolean;
  acceptance_by: string[];
}

const registry = (
  parse(readFileSync(new URL("../../../legal/index.yaml", import.meta.url), "utf8")) as {
    documents: RegistryDocument[];
  }
).documents;

describe("Gateway legal documents", () => {
  it("accepts exactly the registry's documents for external parties at account creation", () => {
    const required = registry
      .filter(
        (d) =>
          d.requires_acceptance_at_signup &&
          d.acceptance_by.includes("external_party_at_account_creation"),
      )
      .map((d) => ({ slug: d.slug, version: d.version }));
    expect(required.length).toBeGreaterThan(0);
    expect(signUpAcceptances()).toEqual(required);
  });

  it("names every linked document with the registry's title and current version", () => {
    for (const doc of GATEWAY_LEGAL_DOCUMENTS) {
      const entry = registry.find((d) => d.slug === doc.slug);
      expect(entry, doc.slug).toBeDefined();
      expect(entry?.publish).toBe("public");
      expect({ title: doc.title, version: doc.version }).toEqual({
        title: entry?.title,
        version: entry?.version,
      });
    }
    expect(gatewayLegalDocument("privacy-policy")?.accept).toBe(false);
    expect(gatewayLegalDocument("data-processing-agreement")).toBeUndefined();
  });

  it("reads pending acceptances from user metadata and ignores anything malformed", () => {
    expect(pendingAcceptances(undefined)).toEqual([]);
    expect(pendingAcceptances({ [PENDING_ACCEPTANCES]: "worker-terms" })).toEqual([]);
    expect(
      pendingAcceptances({
        [PENDING_ACCEPTANCES]: [
          { slug: "worker-terms", version: "1.0.0" },
          { slug: 3, version: "1.0.0" },
          null,
        ],
      }),
    ).toEqual([{ slug: "worker-terms", version: "1.0.0" }]);
  });

  it("takes the client IP from the proxy chain", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe(
      "203.0.113.7",
    );
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(new Headers())).toBeNull();
  });
});
