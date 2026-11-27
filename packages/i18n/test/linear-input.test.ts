import { describe, expect, it } from "vitest";
import { pseudoMessage } from "../src/pseudo.ts";
import { stripFrozenSpans, stripTags, textOf } from "../src/translation/html.ts";

/** Markup and messages are read by position, so an unclosed bracket or brace costs one pass. */
const CEILING_MS = 2_000;

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

describe("markup stripped by position", () => {
  it("removes tags and frozen spans as the patterns did", () => {
    expect(stripTags('a <span id="m1">b</span> <> c')).toBe("a b  c");
    expect(stripTags("a < b")).toBe("a < b");
    expect(textOf("x &amp; <b>y</b>")).toBe("x & y");
    expect(
      stripFrozenSpans('a <span translate="no" id="m1">Atlas</span> b <span id="t1">c</span>'),
    ).toBe('a  b <span id="t1">c</span>');
    expect(stripFrozenSpans('<span translate="no">a\nb</span>')).toBe(
      '<span translate="no">a\nb</span>',
    );
  });

  it("leaves no tag behind when one is wrapped around another", () => {
    expect(stripTags("<scr<script>ipt>x")).not.toContain("<script");
  });

  it("reads unclosed brackets and braces once", () => {
    const { ms } = timed(() => {
      expect(stripTags("<".repeat(400_000))).toHaveLength(400_000);
      expect(pseudoMessage("{".repeat(200_000), "en-XA").length).toBeGreaterThan(200_000);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });
});
