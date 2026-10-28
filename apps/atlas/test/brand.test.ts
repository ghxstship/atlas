import { composite, ratio } from "@xos/tokens/ratio";
import { describe, expect, it } from "vitest";
import { accentPairs, checkAccent, defaultAccent } from "../lib/brand/contrast";

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

describe("the brand editor's live checks (A142)", () => {
  /** What @xos/ui ColorPicker measures for one check: the accent as foreground or fill, under any overlay. */
  const passes = (accent: string) =>
    accentPairs().every((p) => {
      const fg = p.fgIsValue ? accent : (p.fg ?? accent);
      const fill = p.fgIsValue ? (p.bg ?? accent) : accent;
      const bg = p.overlay ? composite(fill, p.overlay.color, p.overlay.opacity) : fill;
      return ratio(fg, bg) >= p.min;
    });

  it("checks every accent pair in every theme, hover and pressed states included", () => {
    const pairs = accentPairs();
    expect(pairs.length).toBe(checkAccent(defaultAccent()).checked);
    expect(new Set(pairs.map((p) => p.theme)).size).toBeGreaterThan(1);
    expect(pairs.some((p) => p.state === "pressed" && p.overlay)).toBe(true);
  });

  it("passes exactly the accents the save action accepts", () => {
    const accents = [defaultAccent(), "#FFE680", "#000000", "#FFFFFF", "#5B63E8", "#0F7B6C"];
    // A spread of hues and lightnesses, so both outcomes are seen.
    for (let i = 0; i < 64; i++) {
      const channel = (shift: number) =>
        ((i * 37 + shift * 91) % 256).toString(16).padStart(2, "0");
      accents.push(`#${channel(0)}${channel(1)}${channel(2)}`.toUpperCase());
    }
    const outcomes = accents.map((a) => [passes(a), checkAccent(a).passes]);
    for (const [live, saved] of outcomes) expect(live).toBe(saved);
    expect(outcomes.some(([, saved]) => saved)).toBe(true);
    expect(outcomes.some(([, saved]) => !saved)).toBe(true);
  });
});
