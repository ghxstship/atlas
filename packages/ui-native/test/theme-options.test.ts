import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeProvider, baseTokens, createTheme, themes, useTheme } from "../src/index.ts";

/**
 * The person's accessibility settings in the native theme (A65-001): me.text_size scales type,
 * me.high_contrast strengthens secondary text and borders, me.reduced_motion shortens motion.
 */
describe("theme options", () => {
  it("keeps the shared theme objects when nothing is asked", () => {
    expect(createTheme("dark")).toEqual(themes.dark);
    expect(createTheme("light", { textScale: 1 }).typography).toBe(baseTokens.typography);
  });

  it("scales every type style for a larger text size", () => {
    const larger = createTheme("dark", { textScale: 1.3 });
    expect(larger.typography.text16.fontSize).toBe(21);
    expect(larger.typography.text16.lineHeight).toBe(30);
    expect(larger.typography.heading24.fontWeight).toBe(baseTokens.typography.heading24.fontWeight);
  });

  it("draws secondary text and borders as strong as primary ones in high contrast", () => {
    const contrast = createTheme("light", { highContrast: true });
    expect(contrast.color.textSecondary).toBe(themes.light.color.textPrimary);
    expect(contrast.color.textTertiary).toBe(themes.light.color.textPrimary);
    expect(contrast.color.borderSubtle).toBe(themes.light.color.borderStrong);
    expect(contrast.color.bgCanvas).toBe(themes.light.color.bgCanvas);
  });

  it("shortens every movement under reduced motion, keeping instant changes instant", () => {
    const reduced = createTheme("dark", { reduceMotion: true });
    expect(reduced.duration.deliberate).toBe(baseTokens.duration.reduced);
    expect(reduced.duration.fast).toBe(baseTokens.duration.reduced);
    expect(reduced.duration.instant).toBe(0);
  });

  it("supplies the options through the provider", () => {
    function Probe(): ReactElement {
      const theme = useTheme();
      return createElement(
        "span",
        null,
        `${theme.typography.text13.fontSize}:${theme.duration.base}:${theme.color.textSecondary === theme.color.textPrimary}`,
      );
    }
    const html = renderToStaticMarkup(
      createElement(ThemeProvider, {
        preference: "dark",
        options: { textScale: 1.15, highContrast: true, reduceMotion: true },
        children: createElement(Probe),
      }),
    );
    expect(html).toContain(`15:${baseTokens.duration.reduced}:true`);
  });
});
