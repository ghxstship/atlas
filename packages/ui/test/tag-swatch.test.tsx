import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tag } from "../src/index.ts";

/** B3 (ADR 0142): a Tag's dot can take a themed categorical color for a user-defined choice or segment. */
describe("Tag swatch", () => {
  it("colors the dot with the categorical token and keeps the label", () => {
    render(<Tag swatch="cat-3">Wide shot</Tag>);
    const label = screen.getByText("Wide shot");
    const dot = label.querySelector("[data-swatch]");
    expect(dot?.getAttribute("data-swatch")).toBe("cat-3");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.className).toContain("bg-viz-cat-3");
    expect(dot?.className).toContain("forced-colors:bg-[CanvasText]");
    expect(label.className).toContain("forced-colors:border");
  });

  it("uses the tone's dot without a swatch", () => {
    render(<Tag tone="warning">Expiring</Tag>);
    const dot = screen.getByText("Expiring").querySelector("[aria-hidden]");
    expect(dot?.hasAttribute("data-swatch")).toBe(false);
    expect(dot?.className).toContain("bg-warning");
  });

  it("covers every color of the palette", () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7] as const) {
      const { unmount } = render(<Tag swatch={`cat-${n}`}>{`Choice ${n}`}</Tag>);
      expect(screen.getByText(`Choice ${n}`).querySelector("[data-swatch]")?.className).toContain(
        `bg-viz-cat-${n}`,
      );
      unmount();
    }
  });
});
