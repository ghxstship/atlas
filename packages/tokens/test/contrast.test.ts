import { describe, expect, it } from "vitest";
import {
  checkContrast,
  composite,
  formatFailure,
  ratio,
  resolveColor,
} from "../scripts/check-contrast.js";
import type { ContrastSpec, TokenSource } from "../scripts/check-contrast.js";
import { readJson } from "./source.ts";

const tokens = readJson<TokenSource>("xos.tokens.json");
const spec = readJson<ContrastSpec>("scripts/contrast-pairs.json");

describe("contrast gate", () => {
  it("passes every declared pair in every theme", () => {
    const result = checkContrast(tokens, spec);
    expect(result.failures.map(formatFailure)).toEqual([]);
    expect(result.themes).toBe(3);
    const perTheme = spec.rules.reduce(
      (n, r) => n + r.fg.length * r.bg.length * (1 + (r.overlays?.length ?? 0)),
      0,
    );
    expect(result.checked).toBe(perTheme * 3);
  });

  it("computes WCAG ratios at the known extremes", () => {
    expect(ratio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(ratio("#fff", "#FFFFFF")).toBeCloseTo(1, 5);
    expect(ratio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
  });

  it("follows references to their themed value", () => {
    expect(resolveColor(tokens, "state-active", "light")).toBe(
      resolveColor(tokens, "accent-default", "light"),
    );
    expect(() => resolveColor(tokens, "no-such-token", "dark")).toThrow(/Unknown color token/);
  });

  it("reports a pair that falls under its threshold", () => {
    const failing: ContrastSpec = {
      rules: [{ name: "Same color", min: 4.5, fg: ["bg-canvas"], bg: ["bg-canvas"] }],
    };
    const result = checkContrast(tokens, failing);
    expect(result.failures).toHaveLength(3);
    expect(result.failures.map(formatFailure)[0]).toBe(
      "FAIL dark Same color: bg-canvas on bg-canvas = 1.00:1 (needs 4.5:1)",
    );
  });

  it("names only color tokens that exist", () => {
    const names = new Set(tokens.color.tokens.map((t) => t.name));
    for (const rule of spec.rules)
      for (const n of [...rule.fg, ...rule.bg]) expect(names).toContain(n);
  });

  it("composites an overlay over a fill, as color-mix in sRGB does", () => {
    expect(composite("#FFFFFF", "#000000", 0.1)).toBe("#e6e6e6");
    expect(composite("#5B63E8", "#000000", 0)).toBe("#5b63e8");
  });

  it("checks the accent fill hovered and pressed, at the opacity tokens' values (A24-004)", () => {
    const base = readJson<{ opacity: Record<string, { $value: number }> }>(
      "tokens/base.tokens.json",
    );
    const rule = spec.rules.find((r) => r.overlays !== undefined);
    expect(rule?.overlays?.map((o) => [o.state, o.color, o.opacity])).toEqual([
      ["hover", "scrim", base.opacity["hover"]?.$value],
      ["pressed", "scrim", base.opacity["pressed"]?.$value],
    ]);
    const failing = checkContrast(tokens, {
      rules: [
        {
          name: "Light overlay",
          min: 4.5,
          fg: ["accent-text-on"],
          bg: ["accent-default"],
          overlays: [{ state: "hover", color: "accent-text-on", opacity: 0.2 }],
        },
      ],
    });
    expect(failing.failures.map((f) => f.bg)).toContain(
      "accent-default hover (accent-text-on at 0.2)",
    );
  });
});
