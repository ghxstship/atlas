import { describe, expect, it } from "vitest";
import { checkAccent, defaultAccent } from "../lib/brand/contrast";

describe("white-label contrast gate", () => {
  it("passes the platform accent", () => {
    const result = checkAccent(defaultAccent());
    expect(result.checked).toBeGreaterThan(0);
    expect(result.passes).toBe(true);
  });

  it("blocks an accent too light for white labels and too faint on light grounds", () => {
    const result = checkAccent("#FFE680");
    expect(result.passes).toBe(false);
    expect(result.failures.some((f) => f.rule === "Label on accent fill")).toBe(true);
  });

  it("refuses anything that is not a six-digit hex color", () => {
    expect(() => checkAccent("red")).toThrow();
  });
});
