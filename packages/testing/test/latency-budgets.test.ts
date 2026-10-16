import { describe, expect, it } from "vitest";
import { apiBudgets, lighthouseAssertions, loadTargets, webBudgets } from "../src/budgets.ts";
import { percentile, summarizeLatencies } from "../src/latency.ts";

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const samples = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
    expect(percentile(samples, 50)).toBe(5);
    expect(percentile(samples, 95)).toBe(10);
    expect(percentile(samples, 100)).toBe(10);
  });

  it("answers null for no samples and refuses an out-of-range percentile", () => {
    expect(percentile([], 95)).toBeNull();
    expect(() => percentile([1], 0)).toThrow(RangeError);
  });

  it("summarizes a sample", () => {
    expect(summarizeLatencies([10, 20, 30])).toEqual({
      count: 3,
      p50: 20,
      p95: 30,
      p99: 30,
      max: 30,
    });
    expect(summarizeLatencies([]).max).toBeNull();
  });
});

describe("budgets", () => {
  it("carry the Section 18 and Section 5.1 values", () => {
    expect(webBudgets.largestContentfulPaintMs).toBe(2500);
    expect(webBudgets.routeJavaScriptGzipBytes).toBe(204_800);
    expect(apiBudgets).toMatchObject({ readP95Ms: 250, writeP95Ms: 400, p99Ms: 800 });
    expect(loadTargets).toEqual({
      platformConcurrentUsers: 10_000,
      tenantConcurrentUsers: 500,
      compassDevicesPerShow: 1_000,
    });
  });

  it("become Lighthouse CI assertions", () => {
    const assertions = lighthouseAssertions();
    expect(assertions["largest-contentful-paint"]).toEqual(["error", { maxNumericValue: 2500 }]);
    expect(assertions["cumulative-layout-shift"]?.[1]).toEqual({ maxNumericValue: 0.1 });
  });
});
