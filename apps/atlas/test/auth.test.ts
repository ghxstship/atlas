import { describe, expect, it } from "vitest";
import { authErrorKey } from "../lib/auth/errors";
import { clientIp, ownerSignupDocuments, signupAcceptances } from "../lib/auth/legal";
import { isOAuthProvider, parseEnabledProviders } from "../lib/auth/providers";
import { safeNext, siteUrl } from "../lib/auth/redirect";
import { LEGAL_DOCUMENTS } from "../lib/legal.generated";

describe("safeNext", () => {
  it("keeps same-site relative paths", () => {
    expect(safeNext("/acme/home?view=list#x")).toBe("/acme/home?view=list#x");
  });

  it("refuses anything that could leave the site", () => {
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil", "evil", "", 5, null]) {
      expect(safeNext(bad)).toBe("/");
    }
    expect(safeNext("x".repeat(3000), "/auth/organization")).toBe("/auth/organization");
  });

  it("builds absolute site links with next", () => {
    expect(siteUrl("http://127.0.0.1:3006", "/auth/callback", "/acme/home")).toBe(
      "http://127.0.0.1:3006/auth/callback?next=%2Facme%2Fhome",
    );
    expect(siteUrl("http://127.0.0.1:3006", "/auth/callback", "/")).toBe(
      "http://127.0.0.1:3006/auth/callback",
    );
  });
});

describe("auth errors", () => {
  it("maps Supabase codes to catalog keys", () => {
    expect(authErrorKey({ code: "invalid_credentials" })).toBe("invalid_credentials");
    expect(authErrorKey({ code: "email_exists" })).toBe("user_already_exists");
    expect(authErrorKey({ code: "otp_expired" })).toBe("link_invalid");
    expect(authErrorKey({ status: 429 })).toBe("over_request_rate_limit");
    expect(authErrorKey({ code: "something_new" })).toBe("unexpected");
  });
});

describe("OAuth providers", () => {
  it("offers only the providers Supabase Auth reports enabled", () => {
    expect(
      parseEnabledProviders({
        external: { google: true, apple: false, azure: true, github: true },
      }),
    ).toEqual(["google", "azure"]);
    expect(parseEnabledProviders(null)).toEqual([]);
    expect(isOAuthProvider("google")).toBe(true);
    expect(isOAuthProvider("github")).toBe(false);
  });
});

describe("legal acceptance at signup", () => {
  it("asks an Owner to accept the Terms of Service and the DPA from legal/index.yaml", () => {
    expect(ownerSignupDocuments().map((d) => d.slug)).toEqual([
      "terms-of-service",
      "data-processing-agreement",
    ]);
    expect(LEGAL_DOCUMENTS.length).toBeGreaterThan(10);
  });

  it("passes each signup document with its current version to the acceptance log", () => {
    expect(signupAcceptances()).toEqual(
      ownerSignupDocuments().map((d) => ({ slug: d.slug, version: d.version })),
    );
    expect(signupAcceptances([])).toEqual([]);
  });

  it("reads the client IP from the proxy headers", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe(
      "203.0.113.9",
    );
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(new Headers())).toBeNull();
  });
});
