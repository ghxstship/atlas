import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "../src/index.ts";

/**
 * A24-004: interactive states keep their label at 4.5:1. A brightness filter moves the label with
 * the fill, so no state uses one; the primary fill darkens with the scrim overlay the contrast gate
 * checks (packages/tokens/scripts/contrast-pairs.json).
 */
describe("button states", () => {
  it("never filters brightness on hover or press", () => {
    for (const variant of ["primary", "secondary", "ghost", "danger"] as const) {
      render(<Button variant={variant}>{variant}</Button>);
      expect(screen.getByRole("button", { name: variant }).className).not.toMatch(/brightness/);
    }
  });

  it("darkens the primary fill with the scrim at the hover and pressed opacities", () => {
    render(<Button variant="primary">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" }).className).toContain("xos-fill-accent");
    const css = readFileSync(resolve(process.cwd(), "src/styles/components.css"), "utf8");
    expect(css).toMatch(/\.xos-fill-accent:hover[^{]*\{[^}]*var\(--opacity-hover\)/);
    expect(css).toMatch(/\.xos-fill-accent:active[^{]*\{[^}]*var\(--opacity-pressed\)/);
  });
});
