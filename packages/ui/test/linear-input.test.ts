import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../src/Editing/parseQuickAdd.tsx";
import { tidyTitle } from "../src/Editing/quickAddCore.ts";
import { parseTimeShorthand } from "../src/Editing/timeShorthand.ts";

/** What a person types or pastes into a quick-add or time field is read in one pass, however long it is. */
const CEILING_MS = 2_000;

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

describe("typed shorthand on long input", () => {
  it("reads a range with any spacing around its separator", () => {
    expect(parseTimeShorthand("9 - 5p")).toEqual(parseTimeShorthand("9-5p"));
    expect(parseTimeShorthand("9   to   5p")).toEqual(parseTimeShorthand("9 to 5p"));
    expect(parseTimeShorthand("9 a 5p")).toEqual(parseTimeShorthand("9-5p"));
    expect(parseTimeShorthand("9 \u2013 17")).toEqual({
      start: "09:00",
      end: "17:00",
      endDayOffset: 0,
    });
  });

  it("tidies a title as before", () => {
    expect(tidyTitle("  Load   in \t , then  \n sound check !  ")).toBe(
      "Load in, then sound check!",
    );
    expect(tidyTitle(", lead")).toBe("lead");
  });

  it("drops the sentence punctuation after a token", () => {
    const parse = parseQuickAdd("Call #venue-._ tomorrow");
    expect(parse.tokens.find((token) => token.type === "tag")?.value).toBe("venue");
  });

  it("reads a pasted run of spaces or hyphens once", () => {
    const { ms } = timed(() => {
      expect(parseTimeShorthand(`9${"\t ".repeat(150_000)}x`)).toBeNull();
      expect(tidyTitle(`a${" \t".repeat(150_000)}b`)).toBe("a b");
      parseQuickAdd(`#a${"-".repeat(100_000)}b`);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });
});
