import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sparkline } from "../src/index.ts";
import { sparklinePath } from "../src/Charts/Sparkline.tsx";

describe("Sparkline", () => {
  it("draws one run per stretch of values and leaves gaps for nulls", () => {
    expect(sparklinePath([0, 1])).toBe("M1,22L95,2");
    expect(sparklinePath([1, null, null, 1, 0])).toBe("M1,2M71.5,2L95,22");
  });

  it("scales from zero, so a flat series sits on its value", () => {
    expect(sparklinePath([2, 2, 2])).toBe("M1,2L48,2L95,2");
  });

  it("is decorative unless labeled", () => {
    const { container, rerender } = render(<Sparkline values={[1, 2, 3]} />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    rerender(<Sparkline values={[1, 2, 3]} label="Trend" />);
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe("Trend");
    expect(container.querySelector("path")?.getAttribute("d")).toMatch(/^M1,/);
  });
});
