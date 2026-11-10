import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MusterLastRead } from "../components/workforce/muster-last-read";

/** The muster's hold on its last list (B8, G-149). The rerender that keeps it needs a browser, which this suite has not. */
const shown = (failed: boolean, children: string | null) =>
  renderToStaticMarkup(
    createElement(MusterLastRead, { failed, note: "Last read", fallback: "Cannot read" }, children),
  );

describe("MusterLastRead", () => {
  it("shows the list while reads succeed, with no note", () => {
    expect(shown(false, "Ann, Ben")).toBe("Ann, Ben");
  });

  it("shows the fallback when the first read fails, having nothing to keep", () => {
    expect(shown(true, null)).toBe("Cannot read");
  });
});
