import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRegisteredIcon, registeredIconNames } from "../src/names.ts";

const sprite = readFileSync(new URL("../src/sprite.generated.svg", import.meta.url), "utf8");

describe("icon sprite (ADR 0027)", () => {
  it("has one symbol with geometry for every registered icon, and nothing else", () => {
    const ids = [
      ...sprite.matchAll(/<symbol id="([A-Za-z0-9]+)" viewBox="0 0 24 24">(.*?)<\/symbol>/g),
    ];
    expect(ids.map((m) => m[1])).toEqual([...registeredIconNames]);
    for (const [, id, body] of ids) {
      expect(body, id).toMatch(/^(<(path|circle|rect|line|polyline|polygon|ellipse) [^>]+\/>)+$/);
    }
  });

  it("carries geometry only, so each use sets stroke, size and color", () => {
    expect(sprite).not.toMatch(/stroke|key=|class=/);
    // Lucide fills a few dots with the current color; nothing else sets a fill.
    expect(sprite.replaceAll('fill="currentColor"', "")).not.toContain("fill=");
    expect(sprite.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="24"')).toBe(true);
  });

  it("checks names without loading components", () => {
    expect(isRegisteredIcon("chevron-right")).toBe(true);
    expect(isRegisteredIcon("home")).toBe(true);
    expect(isRegisteredIcon("Airplay")).toBe(false);
  });
});
