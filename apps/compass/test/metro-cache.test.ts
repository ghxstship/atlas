import { readFileSync } from "node:fs";
import Module from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;

/** Loads metro.config.js as Metro does, as CommonJS, and returns its transform cache version. */
function cacheVersion(): string {
  const file = join(root, "metro.config.js");
  type Loader = Module & {
    _compile(source: string, filename: string): void;
    exports: { cacheVersion?: string };
  };
  const loader = new Module(file) as Loader;
  loader.filename = file;
  loader.paths = (
    Module as unknown as { _nodeModulePaths(dir: string): string[] }
  )._nodeModulePaths(root);
  loader._compile(readFileSync(file, "utf8"), file);
  return String(loader.exports.cacheVersion);
}

const NAMES = ["EXPO_PUBLIC_SUPABASE_URL", "EXPO_PUBLIC_XOS_TEST_ONLY_C27"] as const;
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) Reflect.deleteProperty(process.env, n);
    else process.env[n] = saved[n];
  }
});

describe("C-27: a rebuild with new EXPO_PUBLIC_* values never reuses the old bundle's transforms", () => {
  it("changes Metro's cache version when an inlined value changes", () => {
    process.env["EXPO_PUBLIC_SUPABASE_URL"] = "http://127.0.0.1:64101";
    const first = cacheVersion();
    process.env["EXPO_PUBLIC_SUPABASE_URL"] = "http://127.0.0.1:64191";
    expect(cacheVersion()).not.toBe(first);
  });

  it("changes it when a value is added, and keeps it when nothing changed", () => {
    process.env["EXPO_PUBLIC_SUPABASE_URL"] = "http://127.0.0.1:64101";
    delete process.env["EXPO_PUBLIC_XOS_TEST_ONLY_C27"];
    const before = cacheVersion();
    expect(cacheVersion()).toBe(before);
    process.env["EXPO_PUBLIC_XOS_TEST_ONLY_C27"] = "1";
    expect(cacheVersion()).not.toBe(before);
  });

  it("keys on a digest, so the values themselves are not written into the cache key", () => {
    process.env["EXPO_PUBLIC_SUPABASE_URL"] = "http://127.0.0.1:64101";
    expect(cacheVersion()).not.toContain("127.0.0.1");
    expect(cacheVersion()).toMatch(/\+public-env-[0-9a-f]{16}$/);
  });
});
