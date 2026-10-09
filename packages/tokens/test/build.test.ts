import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { THEMES, dtcgLeaves, pkgPath, readJson } from "./source.ts";

/** Runs build-tokens.mjs against a scratch copy of tokens/ so the test never depends on a prior build. */
let out: string;

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "xos-tokens-"));
  cpSync(pkgPath("tokens"), join(out, "tokens"), { recursive: true });
  execFileSync(process.execPath, [pkgPath("build-tokens.mjs")], { cwd: out, stdio: "pipe" });
});

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

const read = (file: string) => readFileSync(join(out, "dist", file), "utf8");
const cssVars = (css: string) => [...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]);
const nativeExports = (js: string) => [...js.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
const cssName = (path: string) => `--${path.replace(/\./g, "-")}`;

const base = dtcgLeaves(readJson("tokens/base.tokens.json"));

describe("Style Dictionary build", () => {
  it("emits every base token as a :root variable and a native export", () => {
    const css = read("css/base.css");
    expect(css).toMatch(/^:root \{/m);
    expect(cssVars(css).sort()).toEqual([...base.keys()].map(cssName).sort());
    expect(nativeExports(read("native/base.js"))).toHaveLength(base.size);
  });

  it.each(THEMES)("emits only the %s theme tokens, scoped by data-theme", (theme) => {
    const leaves = dtcgLeaves(readJson(`tokens/theme.${theme}.tokens.json`));
    const css = read(`css/theme.${theme}.css`);
    const selector =
      theme === "dark" ? `:root, [data-theme="dark"] {` : `[data-theme="${theme}"] {`;
    expect(css).toContain(selector);
    expect(cssVars(css).sort()).toEqual([...leaves.keys()].map(cssName).sort());
    expect(nativeExports(read(`native/theme.${theme}.js`))).toHaveLength(leaves.size);
  });

  it("keeps references as variables in CSS and resolves them in native output", () => {
    expect(read("css/theme.light.css")).toContain(
      "--color-state-active: var(--color-accent-default);",
    );
    expect(read("native/theme.light.js")).toMatch(
      /export const colorStateActive = "#[0-9a-f]{6}";/,
    );
  });

  it("writes the same variable names the Tailwind preset reads", () => {
    const all = new Set([...cssVars(read("css/base.css")), ...cssVars(read("css/theme.dark.css"))]);
    for (const name of [
      "--color-bg-canvas",
      "--stroke-width-accent",
      "--motion-duration-fast",
      "--space-12",
    ]) {
      expect(all).toContain(name);
    }
  });
});
