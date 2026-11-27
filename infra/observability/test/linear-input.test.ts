import { describe, expect, it } from "vitest";
import { trimStack } from "../src/browser.ts";
import { readFrame } from "../src/sentry.ts";

/** A stack comes from whatever threw; a pattern with open gaps took quadratic time on a long line. */
const CEILING_MS = 2_000;

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

describe("stack lines read by position", () => {
  it("keeps V8 and Firefox frame lines", () => {
    expect(
      trimStack("Error: x\n    at f (a.js:1:2)\ng@https://x.test/b.js:3:4\nnot a frame@x"),
    ).toBe("at f (a.js:1:2)\ng@https://x.test/b.js:3:4");
  });

  it("reads a V8 frame with and without a function name", () => {
    expect(readFrame("    at render (/app/src/a.ts:10:5)")).toEqual([
      "render",
      "/app/src/a.ts",
      "10",
      "5",
    ]);
    expect(readFrame("at /app/src/a.ts:10:5")).toEqual([undefined, "/app/src/a.ts", "10", "5"]);
    expect(readFrame("at new Foo (node:internal/x:1:2)")).toEqual([
      "new Foo",
      "node:internal/x",
      "1",
      "2",
    ]);
    expect(readFrame("at f (a.js)")).toBeNull();
    expect(readFrame("g@b.js:3:4")).toBeNull();
  });

  it("reads hostile lines once", () => {
    const { ms } = timed(() => {
      expect(trimStack("@".repeat(300_000))).toBeUndefined();
      expect(readFrame(`at ${"a (a".repeat(100_000)}`)).toBeNull();
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });
});
