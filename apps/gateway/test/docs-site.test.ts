import { describe, expect, it } from "vitest";
import { docsSiteUrl, parseEnv } from "../lib/env";

/** The help panel's help center links (RRR-119) come from DOCS_SITE_URL only. */
const base = {
  SUPABASE_URL: "http://127.0.0.1:57121",
  SUPABASE_ANON_KEY: "a".repeat(40),
  GATEWAY_SITE_URL: "https://gateway.example.test",
};

describe("docs site origin", () => {
  it("is absent until the docs site is configured", () => {
    expect(docsSiteUrl(parseEnv(base))).toBeNull();
  });

  it("is the configured origin without a trailing slash", () => {
    expect(docsSiteUrl(parseEnv({ ...base, DOCS_SITE_URL: "https://docs.example.test/" }))).toBe(
      "https://docs.example.test",
    );
  });

  it("refuses a docs origin that is not a web URL", () => {
    expect(() => parseEnv({ ...base, DOCS_SITE_URL: "docs.example.test" })).toThrow(
      /DOCS_SITE_URL/,
    );
  });
});
