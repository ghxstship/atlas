import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkRouteBudgets,
  CHUNK_FRAMING_BYTES,
  kb,
  matchRoute,
  RESPONSE_HEADER_BYTES,
  routeBundle,
  transferBytes,
} from "../src/bundle-budget.ts";

const routes = [
  "/[org]/home/page",
  "/[org]/home/today/page",
  "/[org]/p/[projectKey]/overview/page",
  "/(shell)/explore/page",
  "/auth/sign-in/page",
  "/[org]/[...rest]/page",
  "/api/v1/[...path]/route",
];

describe("matchRoute", () => {
  it("maps a URL path to its route, preferring static segments", () => {
    expect(matchRoute(routes, "/demo/home")).toBe("/[org]/home/page");
    expect(matchRoute(routes, "/demo/home/today")).toBe("/[org]/home/today/page");
    expect(matchRoute(routes, "/demo/p/NWS/overview")).toBe("/[org]/p/[projectKey]/overview/page");
    expect(matchRoute(routes, "/auth/sign-in")).toBe("/auth/sign-in/page");
  });

  it("ignores route groups and returns null when nothing serves the path", () => {
    expect(matchRoute(routes, "/explore")).toBe("/(shell)/explore/page");
    expect(matchRoute(routes, "/nowhere/at/all/here")).toBeNull();
  });
});

/** A minimal `.next` directory: two root chunks, one layout chunk and one page chunk. */
function fakeBuild(root: string, app: string, pageBytes: number) {
  const next = join(root, "apps", app, ".next");
  mkdirSync(join(next, "static/chunks"), { recursive: true });
  mkdirSync(join(next, "server/app/auth/sign-in"), { recursive: true });
  const chunk = (name: string, bytes: number) =>
    writeFileSync(join(next, "static/chunks", name), randomText(bytes));
  chunk("root.js", 2_000);
  chunk("layout.js", 1_000);
  chunk("page.js", pageBytes);
  writeFileSync(
    join(next, "build-manifest.json"),
    JSON.stringify({ rootMainFiles: ["static/chunks/root.js"] }),
  );
  writeFileSync(
    join(next, "server/app-paths-manifest.json"),
    JSON.stringify({ "/auth/sign-in/page": "app/auth/sign-in/page.js" }),
  );
  const manifest = {
    entryJSFiles: {
      "[project]/app/layout": ["static/chunks/layout.js"],
      "[project]/app/auth/sign-in/page": [
        "static/chunks/layout.js",
        "/_next/static/chunks/page.js",
      ],
    },
  };
  writeFileSync(
    join(next, "server/app/auth/sign-in/page_client-reference-manifest.js"),
    `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\nglobalThis.__RSC_MANIFEST["/auth/sign-in/page"] = ${JSON.stringify(manifest)};`,
  );
  return next;
}

/** Random base64 text: gzip keeps about three quarters of it. */
function randomText(bytes: number): string {
  return randomBytes(bytes).toString("base64").slice(0, bytes);
}

const only = { atlas: ["/auth/sign-in"], gateway: [], docs: [] };

describe("transferBytes", () => {
  it("counts a script as next start sends it: default-level gzip, headers and framing", () => {
    const body = Buffer.from(randomText(100_000));
    const gzip = gzipSync(body).length;
    expect(gzip).toBeGreaterThan(32 * 1024);
    expect(transferBytes(body)).toBe(
      gzip + RESPONSE_HEADER_BYTES + CHUNK_FRAMING_BYTES * Math.ceil(gzip / 16_384),
    );
  });

  it("charges even a tiny script its headers, which is why fewer chunks weigh less", () => {
    expect(transferBytes(Buffer.from("x"))).toBeGreaterThan(RESPONSE_HEADER_BYTES);
  });
});

describe("routeBundle and checkRouteBudgets", () => {
  it("adds root, layout and page chunks once each", () => {
    const root = mkdtempSync(join(tmpdir(), "bundle-"));
    const bundle = routeBundle(fakeBuild(root, "atlas", 500), "/auth/sign-in");
    expect(bundle.route).toBe("/auth/sign-in/page");
    expect(bundle.files).toEqual([
      "static/chunks/layout.js",
      "static/chunks/page.js",
      "static/chunks/root.js",
    ]);
    // Three responses, each with its headers on top of the gzip body.
    expect(bundle.transferBytes).toBeGreaterThan(2_000 + 3 * RESPONSE_HEADER_BYTES);
  });

  it("fails a page over budget unless a recorded ceiling holds it", () => {
    const root = mkdtempSync(join(tmpdir(), "bundle-"));
    fakeBuild(root, "atlas", 400_000);
    const [row] = checkRouteBudgets(root, {}, only);
    expect(row?.app).toBe("atlas");
    expect(row?.pass).toBe(false);
    const [held] = checkRouteBudgets(root, { "atlas/auth/sign-in": 300 * 1024 }, only);
    expect(held?.pass).toBe(true);
    expect(kb(held?.budgetBytes ?? 0)).toBe("300 KB");
  });

  it("skips apps without a build", () => {
    expect(checkRouteBudgets(mkdtempSync(join(tmpdir(), "bundle-")))).toEqual([]);
  });
});
