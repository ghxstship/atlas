import { describe, expect, it } from "vitest";
import { segmentColorToWrite, shownSegmentColor } from "@/lib/show/segment-color";

/** B3 (ADR 0142): the editor's color follows the segment typed, and only a pick is ever written. */
const colors = { "act ii": "cat-6" };

describe("the cue editor's segment color", () => {
  it("follows the segment typed, ignoring case and outer spaces", () => {
    expect(shownSegmentColor(null, "  ACT II ", colors)).toBe("cat-6");
    expect(shownSegmentColor(null, "Act III", colors)).toBe("");
    expect(shownSegmentColor(null, "", colors)).toBe("");
  });

  it("shows what the person picked, a cleared color included", () => {
    expect(shownSegmentColor("cat-1", "Act II", colors)).toBe("cat-1");
    expect(shownSegmentColor("", "Act II", colors)).toBe("");
  });

  it("writes nothing when the person picked nothing, so a rename never overwrites a color", () => {
    expect(segmentColorToWrite(null, "Act II", colors)).toBeUndefined();
    expect(segmentColorToWrite(null, "Act III", colors)).toBeUndefined();
  });

  it("writes a pick, clears with null, and skips what would change nothing", () => {
    expect(segmentColorToWrite("cat-1", "Act II", colors)).toBe("cat-1");
    expect(segmentColorToWrite("", "Act II", colors)).toBeNull();
    expect(segmentColorToWrite("cat-6", " act ii ", colors)).toBeUndefined();
    expect(segmentColorToWrite("", "Act III", colors)).toBeUndefined();
    expect(segmentColorToWrite("cat-1", "  ", colors)).toBeUndefined();
  });
});
