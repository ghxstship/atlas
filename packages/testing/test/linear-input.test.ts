import { describe, expect, it } from "vitest";
import { definedProperties, exportedNames } from "../src/design-audit.ts";
import { isData } from "../src/pseudo-text.ts";

/** The audits read whole source files; a rule of hyphens or an unclosed brace costs one pass. */
const CEILING_MS = 2_000;

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

describe("audits on long runs", () => {
  it("finds the definitions and exports the patterns found", () => {
    expect([...definedProperties("a{--x-1 : 1px; color: var(--y)} ----z:0")]).toEqual([
      "--x-1",
      "----z",
    ]);
    expect(
      [...exportedNames("export { A, type B, C  as  D } from './x'; export{E}")].sort(),
    ).toEqual(["A", "D", "E"]);
  });

  it("reads hostile source once", () => {
    const { ms } = timed(() => {
      expect(definedProperties("-".repeat(300_000)).size).toBe(0);
      expect(exportedNames("export{{".repeat(100_000)).size).toBe(0);
      expect(exportedNames(`export { a${" ".repeat(200_000)}b }`).size).toBe(1);
      expect(isData(`${"\t".repeat(300_000)}x${"\t".repeat(300_000)}`, {} as never)).toBe(true);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });
});
