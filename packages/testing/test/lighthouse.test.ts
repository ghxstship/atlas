import { describe, expect, it } from "vitest";
import {
  SSR_CHUNK_SIZE,
  lighthouseRc,
  lighthouseTargets,
  scorePage,
  sessionCookieHeader,
} from "../src/lighthouse.ts";

const session = { access_token: "a", refresh_token: "r" };

describe("sessionCookieHeader", () => {
  it("encodes a short session as one base64url cookie", () => {
    const header = sessionCookieHeader("xos-auth", session);
    expect(header.startsWith("xos-auth=base64-")).toBe(true);
    const value = header.slice("xos-auth=base64-".length);
    expect(JSON.parse(Buffer.from(value, "base64url").toString())).toEqual(session);
  });

  it("chunks a long session the way @supabase/ssr does", () => {
    const long = { ...session, user: { note: "x".repeat(SSR_CHUNK_SIZE * 2) } };
    const parts = sessionCookieHeader("xos-auth", long).split("; ");
    expect(parts.length).toBe(3);
    expect(parts.map((p) => p.split("=")[0])).toEqual(["xos-auth.0", "xos-auth.1", "xos-auth.2"]);
    const joined = parts.map((p) => p.slice(p.indexOf("=") + 1)).join("");
    expect(JSON.parse(Buffer.from(joined.slice(7), "base64url").toString())).toEqual(long);
  });
});

describe("lighthouseRc", () => {
  it("lists the app's key pages with the session cookie and the spec budgets", () => {
    const rc = lighthouseRc({
      app: "atlas",
      baseUrl: "http://127.0.0.1:3006",
      cookie: "xos-auth=v",
      chromePath: "/chrome",
      outputDir: "/out",
    });
    expect(rc.ci.collect.url).toHaveLength(lighthouseTargets.atlas.paths.length);
    expect(rc.ci.collect.url[0]).toBe("http://127.0.0.1:3006/auth/sign-in");
    expect(rc.ci.collect.settings.extraHeaders).toBe(JSON.stringify({ Cookie: "xos-auth=v" }));
    expect(rc.ci.collect.chromePath).toBe("/chrome");
    expect(rc.ci.assert.assertions["largest-contentful-paint"]).toBeDefined();
  });

  it("sends no cookie for public-only apps", () => {
    const rc = lighthouseRc({
      app: "docs",
      baseUrl: "http://x",
      cookie: null,
      chromePath: undefined,
      outputDir: "/out",
    });
    expect("extraHeaders" in rc.ci.collect.settings).toBe(false);
    expect("chromePath" in rc.ci.collect).toBe(false);
  });
});

describe("scorePage", () => {
  const report = (lcp: number, scriptBytes: number) => ({
    requestedUrl: "http://x/home",
    categories: { performance: { score: 0.97 }, accessibility: { score: 1 } },
    audits: {
      "largest-contentful-paint": { numericValue: lcp },
      "cumulative-layout-shift": { numericValue: 0.01 },
      "total-blocking-time": { numericValue: 40 },
      "resource-summary": {
        details: { items: [{ resourceType: "script", transferSize: scriptBytes }] },
      },
    },
  });

  it("passes a page inside every budget", () => {
    expect(scorePage(report(1200, 150_000))).toMatchObject({
      url: "http://x/home",
      performance: 0.97,
      withinBudget: true,
    });
  });

  it("fails a page over the LCP or script budget, and one with missing audits", () => {
    expect(scorePage(report(3000, 150_000)).withinBudget).toBe(false);
    expect(scorePage(report(1200, 300_000)).withinBudget).toBe(false);
    expect(scorePage({}).withinBudget).toBe(false);
  });
});
