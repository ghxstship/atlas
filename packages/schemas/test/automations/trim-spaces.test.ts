import { describe, expect, it } from "vitest";
import { trimSpaces } from "../../src/automations/model.ts";

describe("trimSpaces", () => {
  it("trims spaces only, as Postgres btrim does", () => {
    expect(trimSpaces("  a b  ")).toBe("a b");
    expect(trimSpaces("\t a \n")).toBe("\t a \n");
    expect(trimSpaces("   ")).toBe("");
    expect(trimSpaces("")).toBe("");
  });

  it("reads a long run of spaces inside the text once", () => {
    const started = performance.now();
    expect(trimSpaces(`a${" ".repeat(400_000)}b`)).toHaveLength(400_002);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
