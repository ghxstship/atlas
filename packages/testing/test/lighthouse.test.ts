import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  SSR_CHUNK_SIZE,
  lighthouseRc,
  runAssertions,
  lighthouseTargets,
  scorePage,
  SESSION_COOKIES_ENV,
  sessionCookies,
} from "../src/lighthouse.ts";

const session = { access_token: "a", refresh_token: "r" };

describe("sessionCookies", () => {
  it("encodes a short session as one base64url cookie", () => {
    const [cookie, ...rest] = sessionCookies("xos-auth", session);
    expect(rest).toEqual([]);
    expect(cookie?.name).toBe("xos-auth");
    expect(cookie?.value.startsWith("base64-")).toBe(true);
    const value = cookie?.value.slice("base64-".length) ?? "";
    expect(JSON.parse(Buffer.from(value, "base64url").toString())).toEqual(session);
  });

  it("chunks a long session the way @supabase/ssr does", () => {
    const long = { ...session, user: { note: "x".repeat(SSR_CHUNK_SIZE * 2) } };
    const parts = sessionCookies("xos-auth", long);
    expect(parts.map((p) => p.name)).toEqual(["xos-auth.0", "xos-auth.1", "xos-auth.2"]);
    const joined = parts.map((p) => p.value).join("");
    expect(JSON.parse(Buffer.from(joined.slice(7), "base64url").toString())).toEqual(long);
  });
});

describe("lighthouseRc", () => {
  it("lists the run's pages, sets the session through the cookie jar and asserts the spec budgets", () => {
    const rc = lighthouseRc({
      baseUrl: "http://127.0.0.1:3006",
      paths: lighthouseTargets.atlas.paths,
      sessionScript: "../../../../src/lighthouse-session.cjs",
      chromePath: "/chrome",
      outputDir: "/out",
    });
    expect(rc.ci.collect.url).toHaveLength(lighthouseTargets.atlas.paths.length);
    expect(rc.ci.collect.url[0]).toBe("http://127.0.0.1:3006/auth/sign-in");
    expect(rc.ci.collect.puppeteerScript).toBe("../../../../src/lighthouse-session.cjs");
    expect(rc.ci.collect.puppeteerLaunchOptions).toEqual({ args: ["--no-sandbox"] });
    // An extra Cookie header gives way to the jar once the page sets a cookie of its own.
    expect("extraHeaders" in rc.ci.collect.settings).toBe(false);
    expect(rc.ci.collect.chromePath).toBe("/chrome");
    expect(rc.ci.assert.assertions?.["largest-contentful-paint"]).toBeDefined();
  });

  it("launches Chrome itself, with no session, for public-only apps", () => {
    const rc = lighthouseRc({
      baseUrl: "http://x",
      paths: lighthouseTargets.docs.paths,
      sessionScript: null,
      chromePath: undefined,
      outputDir: "/out",
    });
    expect("puppeteerScript" in rc.ci.collect).toBe(false);
    expect(rc.ci.collect.settings).toEqual({
      preset: "desktop",
      chromeFlags: "--headless=new --no-sandbox",
    });
    expect("chromePath" in rc.ci.collect).toBe(false);
  });
});

describe("lighthouse-session.cjs", () => {
  const require = createRequire(import.meta.url);
  const setSession = require("../src/lighthouse-session.cjs") as (
    browser: { setCookie: (...cookies: unknown[]) => Promise<void> },
    context: { url: string },
  ) => Promise<void>;

  it("puts the session cookies in the browser's jar for the page's host", async () => {
    const set: unknown[] = [];
    vi.stubEnv(SESSION_COOKIES_ENV, JSON.stringify(sessionCookies("xos-auth", session)));
    try {
      await setSession(
        { setCookie: async (...cookies) => void set.push(...cookies) },
        { url: "http://127.0.0.1:3006/demo-productions/home" },
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect(set).toEqual([
      expect.objectContaining({
        name: "xos-auth",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      }),
    ]);
  });

  it("refuses to run without a session", async () => {
    await expect(
      setSession({ setCookie: async () => undefined }, { url: "http://127.0.0.1:3006/" }),
    ).rejects.toThrow(/no session cookie/);
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
    expect(scorePage(report(1200, 300_000), 310_000).withinBudget).toBe(true);
    expect(scorePage({}).withinBudget).toBe(false);
  });
});

describe("runAssertions", () => {
  it("gives every page the 200 KB script budget when none holds a ceiling", () => {
    const assert = runAssertions("http://x", ["/a", "/b"]);
    expect(assert.assertions?.["resource-summary:script:size"]).toEqual([
      "error",
      { maxNumericValue: 204_800 },
    ]);
  });

  it("matches each page to its own script budget by exact URL", () => {
    const assert = runAssertions("http://x", ["/a", "/b.c", "/d"], { "/b.c": 230_000 });
    const matrix = assert.assertMatrix ?? [];
    expect(matrix).toHaveLength(2);
    const budgetOf = (url: string) =>
      matrix.find((m) => new RegExp(m.matchingUrlPattern).test(url))?.assertions[
        "resource-summary:script:size"
      ]?.[1];
    expect(budgetOf("http://x/a")).toEqual({ maxNumericValue: 204_800 });
    expect(budgetOf("http://x/b.c")).toEqual({ maxNumericValue: 230_000 });
    expect(budgetOf("http://x/bxc")).toBeUndefined();
    expect(budgetOf("http://x/d/e")).toBeUndefined();
  });
});
