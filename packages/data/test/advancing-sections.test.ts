import { describe, expect, it } from "vitest";
import { sectionConfig, windowBounds } from "../src/advancing.ts";

describe("section kinds (R9)", () => {
  it("keeps only the configuration a kind allows", () => {
    expect(sectionConfig({ kind: "Text", maxLines: 4, perPerson: true })).toEqual({
      kind: "Text",
      windowKind: null,
      maxLines: null,
      perPerson: false,
    });
    expect(sectionConfig({ kind: "File", maxLines: 3 })).toEqual({
      kind: "File",
      windowKind: null,
      maxLines: 3,
      perPerson: false,
    });
    expect(sectionConfig({ kind: "File", maxLines: 11 })).toBeNull();
    expect(sectionConfig({ kind: "Schedule Window", maxLines: 2 })).toBeNull();
    expect(
      sectionConfig({
        kind: "Schedule Window",
        windowKind: "Load In",
        maxLines: 2,
        perPerson: true,
      }),
    ).toEqual({
      kind: "Schedule Window",
      windowKind: "Load In",
      maxLines: 2,
      perPerson: false,
    });
    expect(sectionConfig({ kind: "Item Request", maxLines: 6, perPerson: true })?.perPerson).toBe(
      true,
    );
    expect(sectionConfig({ kind: "Credential Request", maxLines: null })).toBeNull();
  });

  it("reads the bounds of a window", () => {
    expect(windowBounds('["2027-06-01 08:00:00+00","2027-06-01 10:00:00+00")')).toEqual({
      from: "2027-06-01T08:00:00.000Z",
      to: "2027-06-01T10:00:00.000Z",
    });
    expect(windowBounds(null)).toEqual({ from: null, to: null });
    expect(windowBounds("empty")).toEqual({ from: null, to: null });
  });
});
