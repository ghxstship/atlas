import { describe, expect, it } from "vitest";
import { webBudgets } from "../src/budgets.ts";
import { scriptRequests, servedRow, servedTargets } from "../src/served-budget.ts";

describe("scriptRequests", () => {
  it("keeps the scripts that finished, at the protocol's encoded length", () => {
    const scripts = scriptRequests([
      { kind: "request", id: "1", type: "Script", url: "http://x/_next/a.js" },
      { kind: "request", id: "2", type: "Document", url: "http://x/" },
      { kind: "request", id: "3", type: "Script", url: "http://x/_next/lazy.js" },
      { kind: "finished", id: "2", encodedDataLength: 9_000 },
      { kind: "finished", id: "1", encodedDataLength: 70_400 },
      { kind: "finished", id: "3", encodedDataLength: 2_951 },
    ]);
    expect(scripts).toEqual([
      { url: "http://x/_next/a.js", transferBytes: 70_400 },
      { url: "http://x/_next/lazy.js", transferBytes: 2_951 },
    ]);
  });
});

describe("servedRow", () => {
  const scripts = [
    { url: "a", transferBytes: 150_000 },
    { url: "b", transferBytes: 60_000 },
  ];

  it("fails a page whose scripts pass the route JavaScript budget", () => {
    const row = servedRow("atlas", "/demo-productions/projects", scripts);
    expect(row.transferBytes).toBe(210_000);
    expect(row.budgetBytes).toBe(webBudgets.routeJavaScriptGzipBytes);
    expect(row.pass).toBe(false);
  });

  it("holds a page at its recorded ceiling", () => {
    const row = servedRow("atlas", "/x", scripts, { "atlas/x": 215_000 });
    expect(row.pass).toBe(true);
  });
});

describe("servedTargets", () => {
  it("names each app's key pages, its demo person and its base URL", () => {
    const [atlas, docs] = servedTargets(["atlas", "docs"], { atlas: "http://127.0.0.1:9" });
    expect(atlas?.baseUrl).toBe("http://127.0.0.1:9");
    expect(atlas?.email).toBe("owner@example.com");
    expect(atlas?.paths).toContain("/demo-productions/projects");
    expect(docs?.email).toBeNull();
    expect(docs?.baseUrl).toBe("http://127.0.0.1:3014");
  });
});
