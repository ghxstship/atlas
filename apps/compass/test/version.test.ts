import { getMessages } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import { compareVersions, mustUpdate, parseCachedFloor, parseVersion } from "../src/domain/version";

describe("forced update (journey 40, Section 5.1)", () => {
  it("orders MAJOR.MINOR.PATCH numerically", () => {
    expect(parseVersion("4.10.2")).toEqual([4, 10, 2]);
    expect(compareVersions("4.0.0", "4.0.0")).toBe(0);
    expect(compareVersions("4.9.0", "4.10.0")).toBeLessThan(0);
    expect(compareVersions("5.0.0", "4.99.99")).toBeGreaterThan(0);
    expect(compareVersions("4.0", "4.0.0")).toBeNull();
  });

  it("blocks a build below the advertised floor and only then", () => {
    const floor = { minimumVersion: "4.1.0", updateUrl: null };
    expect(mustUpdate("4.0.0", floor)).toBe(true);
    expect(mustUpdate("4.1.0", floor)).toBe(false);
    expect(mustUpdate("4.2.3", floor)).toBe(false);
    expect(mustUpdate("4.0.0", null)).toBe(false);
  });

  it("never locks crew out on a malformed build or floor", () => {
    expect(mustUpdate("", { minimumVersion: "4.1.0", updateUrl: null })).toBe(false);
    expect(mustUpdate("4.0.0", { minimumVersion: "latest", updateUrl: null })).toBe(false);
  });

  it("keeps the last floor offline and ignores an unreadable cache", () => {
    const floor = { minimumVersion: "4.1.0", updateUrl: "https://apps.example.com/compass" };
    expect(parseCachedFloor(JSON.stringify(floor))).toEqual(floor);
    expect(parseCachedFloor(JSON.stringify({ minimumVersion: "4.1.0" }))).toEqual({
      minimumVersion: "4.1.0",
      updateUrl: null,
    });
    expect(parseCachedFloor("{not json")).toBeNull();
    expect(parseCachedFloor(JSON.stringify({ minimumVersion: "soon" }))).toBeNull();
    expect(parseCachedFloor(null)).toBeNull();
  });

  it("has its copy in both locales", () => {
    type Update = { compass: { update: Record<string, string> } };
    for (const locale of ["en-US", "es-US"] as const) {
      const copy = (getMessages(locale) as unknown as Update).compass.update;
      for (const key of ["message", "messageNoLink", "versions", "action", "recheck"]) {
        expect(copy[key], `${locale} compass.update.${key}`).toBeTypeOf("string");
      }
    }
  });
});
