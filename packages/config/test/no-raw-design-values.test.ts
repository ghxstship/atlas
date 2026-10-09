import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import { noRawDesignValues } from "../eslint/no-raw-design-values.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const tsx = "component.tsx";

tester.run("xos/no-raw-design-values", noRawDesignValues, {
  valid: [
    { code: `const bg = "var(--color-bg-canvas)";` },
    { code: `const cls = "bg-bg-canvas p-12 border-stroke-accent duration-fast";` },
    { code: `const reset = "0px";` },
    { code: `const anchor = "#section-two";` },
    { code: `const entity = "&#123;";` },
    { code: `const issue = "see #12345 for context";` },
    { code: `const word = "rgbCode";` },
    { code: `const call = "getColor(x)";` },
    { code: `import x from "#internal/abc";` },
    { code: `export * from "#fed";` },
    { code: `const m = await import("#bad");` },
    { code: `"use client";` },
    { code: "const t = `${size}px`;" },
    { code: `const ratio = { width: 12 };` },
    { code: `const el = <div style={{ padding: 0, opacity: 0.5, zIndex: 3 }} />;`, filename: tsx },
    { code: `const el = <div style={{ padding: "var(--space-12)" }} />;`, filename: tsx },
    {
      code: `const el = <div style={{ transitionDuration: "var(--motion-duration-fast)" }} />;`,
      filename: tsx,
    },
    { code: `const wait = "Retry in 5s";` },
  ],
  invalid: [
    { code: `const c = "#0E0F11";`, errors: [{ messageId: "color", data: { value: "#0E0F11" } }] },
    { code: `const c = "#fff";`, errors: [{ messageId: "color" }] },
    { code: `const c = "#ffffff80";`, errors: [{ messageId: "color" }] },
    {
      code: `const c = "1px solid #26272c";`,
      errors: [{ messageId: "color" }, { messageId: "size" }],
    },
    {
      code: `const c = "rgba(0,0,0,0.48)";`,
      errors: [{ messageId: "color", data: { value: "rgba(" } }],
    },
    { code: `const c = "hsl(200 50% 50%)";`, errors: [{ messageId: "color" }] },
    { code: `const c = "oklch(0.7 0.1 250)";`, errors: [{ messageId: "color" }] },
    { code: `const s = "12px";`, errors: [{ messageId: "size", data: { value: "12px" } }] },
    { code: `const s = "-0.5px";`, errors: [{ messageId: "size" }] },
    { code: "const s = `calc(100% - ${gap}) 24px`;", errors: [{ messageId: "size" }] },
    { code: `type Brand = "#4F57D9";`, errors: [{ messageId: "color" }] },
    {
      code: `const el = <div style={{ padding: 12, marginInlineStart: 4 }} />;`,
      filename: tsx,
      errors: [{ messageId: "size" }, { messageId: "size" }],
    },
    {
      code: `const el = <div style={{ "font-size": 13 }} />;`,
      filename: tsx,
      errors: [{ messageId: "size" }],
    },
    {
      code: `const el = <div style={{ transition: "opacity 200ms ease" }} />;`,
      filename: tsx,
      errors: [{ messageId: "duration", data: { value: "200ms" } }],
    },
    {
      code: `const el = <div style={{ animationDuration: 1 }} />;`,
      filename: tsx,
      errors: [{ messageId: "duration" }],
    },
    {
      code: `const el = <div style={{ color: "#fff", borderRadius: "6px" }} />;`,
      filename: tsx,
      errors: [{ messageId: "color" }, { messageId: "size" }],
    },
  ],
});
