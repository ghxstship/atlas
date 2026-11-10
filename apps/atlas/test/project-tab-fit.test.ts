import { describe, expect, it } from "vitest";
import { fit } from "../components/projects/tab-fit";

const edges = [100, 200, 300, 400];
const widths = [100, 100, 100, 100];

describe("project tabs that fit the bar", () => {
  it("shows every tab when the last one fits", () => {
    expect(fit(edges, widths, 400, 60, 0)).toBe(4);
  });

  it("keeps room for More when they do not", () => {
    // 200 + 16 + 60 fits in 300; 300 + 16 + 60 does not.
    expect(fit(edges, widths, 300, 60, 0)).toBe(2);
  });

  it("keeps room for the current tab when it would overflow", () => {
    // The fourth tab stays in the bar, so only the first fits beside it and More.
    expect(fit(edges, widths, 380, 60, 3)).toBe(1);
  });

  it("gives up a tab when the rendered bar needed more than the measure said", () => {
    // Every tab measured as fitting 400, but the bar rendered 30 past its edge, so 30 less is available.
    expect(fit(edges, widths, 400, 60, 0)).toBe(4);
    expect(fit(edges, widths, 400 - 30, 60, 0)).toBe(2);
  });

  it("never reports a negative count", () => {
    expect(fit([], [], 100, 60, -1)).toBe(0);
    expect(fit(edges, widths, 10, 60, 0)).toBe(0);
  });
});
