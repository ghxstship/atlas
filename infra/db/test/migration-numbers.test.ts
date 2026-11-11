import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseMigrationName,
  releaseNumber,
  releaseOf,
  type MigrationNumber,
} from "../src/migration-numbers.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const migrations = readdirSync(`${repo}supabase/migrations`)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.slice(0, -".sql".length));

/** Where a migration applies: the legacy era first, then releases by number. */
const rank = (p: MigrationNumber) =>
  p.era === "legacy"
    ? p.number
    : 10_000 + ((p.major * 100 + p.minor) * 100 + p.block) * 100 + p.place;

describe("the repository's migrations (ADR 0022)", () => {
  it("are each numbered in the 4.0 era or by their release", () => {
    const broken = migrations.flatMap((name) => {
      try {
        parseMigrationName(name);
        return [];
      } catch (error) {
        return [(error as Error).message];
      }
    });
    expect(broken).toEqual([]);
  });

  it("sort as text in the order they apply, as Supabase sorts them", () => {
    const byText = [...migrations].sort();
    const byNumber = [...migrations].sort(
      (a, b) => rank(parseMigrationName(a)) - rank(parseMigrationName(b)),
    );
    expect(byText).toEqual(byNumber);
  });

  it("never share a number", () => {
    const numbers = migrations.map((name) => name.slice(0, name.indexOf("_")));
    expect(numbers.filter((n, i) => numbers.indexOf(n) !== i)).toEqual([]);
  });
});

describe("parseMigrationName", () => {
  it("reads the 4.0 era up to 6999", () => {
    expect(parseMigrationName("0001_extensions")).toEqual({ era: "legacy", number: 1 });
    expect(parseMigrationName("6999_notification_kind_seed")).toEqual({
      era: "legacy",
      number: 6999,
    });
  });

  it("reads a release number as release, block and place", () => {
    expect(parseMigrationName("905001203_maps_tiles")).toEqual({
      era: "release",
      major: 5,
      minor: 0,
      block: 12,
      place: 3,
    });
    expect(releaseOf(parseMigrationName("904090001_fix"))).toBe("4.9");
    expect(releaseOf(parseMigrationName("0100_x"))).toBeNull();
  });

  it("refuses four digits past 6999, releases before 4.9, place 00 and other shapes", () => {
    expect(() => parseMigrationName("7000_pl1")).toThrow(/end at 6999/);
    expect(() => parseMigrationName("904080001_x")).toThrow(/start at 4.9/);
    expect(() => parseMigrationName("903990001_x")).toThrow(/start at 4.9/);
    expect(() => parseMigrationName("905000100_x")).toThrow(/01 to 99/);
    expect(() => parseMigrationName("50000001_x")).toThrow(/9MMmmBBSS/);
    expect(() => parseMigrationName("905000101_Bad-Name")).toThrow(/snake_case/);
    expect(() => parseMigrationName("20261109120000_x")).toThrow(/9MMmmBBSS/);
  });
});

describe("releaseNumber", () => {
  it("writes release, block and place as nine digits", () => {
    expect(releaseNumber(5, 0, 12, 3)).toBe("905001203");
    expect(releaseNumber(4, 9, 0, 1)).toBe("904090001");
    expect(releaseNumber(5, 0, 99, 1)).toBe("905009901");
  });

  it("refuses parts that do not fit or a release before 4.9", () => {
    expect(() => releaseNumber(5, 0, 100, 1)).toThrow(RangeError);
    expect(() => releaseNumber(5, 0, 1, 0)).toThrow(RangeError);
    expect(() => releaseNumber(5, 0.5, 1, 1)).toThrow(RangeError);
    expect(() => releaseNumber(4, 8, 0, 1)).toThrow(/start at 4.9/);
  });
});
