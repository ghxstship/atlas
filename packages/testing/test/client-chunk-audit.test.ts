import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findForbiddenClientCode } from "../src/client-chunk-audit.ts";

/**
 * ADR 0025: the Sentry browser SDK never ships to a browser. `budget:js` runs this audit after
 * every production build in CI; these tests pin what it detects.
 */
const roots: string[] = [];

function fakeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "xos-chunk-audit-"));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("findForbiddenClientCode", () => {
  it("finds the Sentry SDK by its carrier, SDK name, auth parameter or ingest host", () => {
    const root = fakeRepo({
      "apps/atlas/.next/static/chunks/a.js":
        "var x=globalThis.__SENTRY__=globalThis.__SENTRY__||{};",
      "apps/atlas/.next/static/chunks/nested/b.js": 'sdk:{name:"sentry.javascript.nextjs"}',
      "apps/gateway/.next/static/chunks/c.js": "u+'?sentry_key='+k",
      "apps/gateway/.next/static/chunks/d.js":
        'fetch("https://o1.ingest.us.sentry.io/api/1/envelope/")',
      "apps/gateway/.next/static/chunks/clean.js": 'navigator.sendBeacon("/api/client-errors",b)',
      "apps/gateway/.next/static/css/e.css": "__SENTRY__",
      "apps/gateway/.next/server/chunks/f.js": "__SENTRY__",
    });
    const { scanned, hits } = findForbiddenClientCode(root);
    expect(scanned).toEqual(["atlas", "gateway"]);
    expect(hits.map((h) => `${h.app}:${h.file}`).sort()).toEqual([
      "atlas:chunks/a.js",
      "atlas:chunks/nested/b.js",
      "gateway:chunks/c.js",
      "gateway:chunks/d.js",
    ]);
    expect(new Set(hits.map((h) => h.name))).toEqual(new Set(["Sentry SDK"]));
  });

  it("passes the reporter and skips apps without a build", () => {
    const root = fakeRepo({
      "apps/atlas/.next/static/chunks/reporter.js":
        'navigator.sendBeacon?.("/api/client-errors",new Blob([JSON.stringify(a)]))',
    });
    expect(findForbiddenClientCode(root)).toEqual({ scanned: ["atlas"], hits: [] });
  });

  it("finds no Sentry SDK in the real production builds, when they exist", () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const built = ["atlas", "gateway"].filter((app) =>
      existsSync(join(repoRoot, "apps", app, ".next", "static")),
    );
    expect(findForbiddenClientCode(repoRoot, built).hits).toEqual([]);
  });
});
