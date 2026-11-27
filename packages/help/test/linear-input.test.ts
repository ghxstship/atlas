import { describe, expect, it } from "vitest";
import { parseBody, parseInline } from "../src/model";

/** A pattern that rescans from every unclosed mark takes minutes at these sizes; reading by position takes milliseconds. */
const CEILING_MS = 2_000;

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

describe("parseInline by position", () => {
  it("reads the marks the pattern read", () => {
    expect(parseInline("a **b** `c` [d](e) f")).toEqual([
      { t: "text", v: "a " },
      { t: "strong", v: "b" },
      { t: "text", v: " " },
      { t: "code", v: "c" },
      { t: "text", v: " " },
      { t: "link", v: "d", href: "e" },
      { t: "text", v: " f" },
    ]);
    expect(parseInline("[[a](b)")).toEqual([{ t: "link", v: "[a", href: "b" }]);
    expect(parseInline("**a* `` [x](y z) [](h)")).toEqual([
      { t: "text", v: "**a* `` [x](y z) [](h)" },
    ]);
    expect(parseInline("***a**")).toEqual([
      { t: "text", v: "*" },
      { t: "strong", v: "a" },
    ]);
  });

  it("reads text made of unclosed marks once", () => {
    const hostile = "[".repeat(200_000) + "[a](b ".repeat(100_000) + "**a*b".repeat(50_000);
    const { value, ms } = timed(() => parseInline(hostile));
    expect(value).toEqual([{ t: "text", v: hostile }]);
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it("ends a block at a whole comment line only", () => {
    expect(parseBody("a\n<!-- generated -->\nb")).toHaveLength(2);
    expect(parseBody("a\n<!-->\nb")).toHaveLength(1);
  });
});
