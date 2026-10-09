import stylelint from "stylelint";
import { describe, expect, it } from "vitest";
import config from "../stylelint/index.mjs";

async function warnings(code: string): Promise<string[]> {
  const result = await stylelint.lint({ code, config });
  const [first] = result.results;
  expect(first?.invalidOptionWarnings).toEqual([]);
  return (first?.warnings ?? []).map((w) => w.rule);
}

describe("shared Stylelint config", () => {
  it("accepts token-only, logical CSS", async () => {
    const css = `
      .row {
        margin-inline-start: var(--space-4);
        padding-block: var(--space-8);
        inset-inline-end: 0;
        color: var(--color-text-primary);
        background: transparent;
        border-color: currentColor;
        border-width: var(--stroke-width-hairline);
        text-align: start;
        float: inline-start;
        transition: opacity var(--motion-duration-fast) var(--motion-easing-standard);
        fill: color-mix(in srgb, var(--color-accent-default) 50%, transparent);
        line-height: 1.45;
        inline-size: 100%;
      }
      @media (min-width: 768px) {
        .row { inline-size: var(--layout-form); }
      }
    `;
    expect(await warnings(css)).toEqual([]);
  });

  it.each([
    ["margin-left", ".a { margin-left: var(--space-4); }"],
    ["padding-right", ".a { padding-right: var(--space-4); }"],
    ["top", ".a { top: 0; }"],
    ["width", ".a { width: 100%; }"],
    ["text-align left", ".a { text-align: left; }"],
    ["float right", ".a { float: right; }"],
    [
      "border-left",
      ".a { border-left: var(--stroke-width-hairline) solid var(--color-border-subtle); }",
    ],
  ])("refuses the physical %s", async (_, css) => {
    expect(await warnings(css)).toContain("liberty/use-logical-spec");
  });

  it.each([
    ["hex", ".a { color: #0e0f11; }", "color-no-hex"],
    ["short hex", ".a { color: #fff; }", "color-no-hex"],
    ["named color", ".a { color: red; }", "color-named"],
    ["rgb()", ".a { color: rgb(0 0 0); }", "function-disallowed-list"],
    [
      "rgba()",
      ".a { box-shadow: 0 0 0 var(--stroke-width-hairline) rgba(0, 0, 0, 0.4); }",
      "function-disallowed-list",
    ],
    ["hsl()", ".a { color: hsl(200 50% 50%); }", "function-disallowed-list"],
    ["oklch()", ".a { color: oklch(0.7 0.1 250); }", "function-disallowed-list"],
    ["color()", ".a { color: color(display-p3 1 0 0); }", "function-disallowed-list"],
  ])("refuses a raw %s color", async (_, css, rule) => {
    expect(await warnings(css)).toContain(rule);
  });

  it.each([
    ["pixel length", ".a { padding-inline: 12px; }"],
    ["pixel font size", ".a { font-size: 13px; }"],
    ["pixel fallback", ".a { gap: var(--space-8, 8px); }"],
    ["millisecond duration", ".a { transition: opacity 200ms; }"],
    ["second duration", ".a { animation-duration: 0.2s; }"],
  ])("refuses a raw %s", async (_, css) => {
    expect(await warnings(css)).toContain("unit-disallowed-list");
  });

  it("allows pixel breakpoints in media queries only", async () => {
    expect(await warnings("@media (max-width: 767px) { .a { inline-size: 100%; } }")).toEqual([]);
    expect(await warnings("@media (max-width: 767px) { .a { inline-size: 320px; } }")).toEqual([
      "unit-disallowed-list",
    ]);
  });
});
