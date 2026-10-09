import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { compile } from "@tailwindcss/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTokens, declaredVars, type TokenBuild } from "./build.ts";

/** The shared preset, loaded through its package export exactly as an app's tailwind.config.cjs loads it. */
type Scale = Record<string, unknown>;
interface Preset {
  darkMode: unknown;
  theme: Record<string, Scale> & { extend: Record<string, Scale> };
}
const preset = createRequire(import.meta.url)("@xos/config/tailwind/preset.js") as Preset;

const fixture = fileURLToPath(new URL("./fixtures/tailwind/", import.meta.url));

/** Utility prefix per theme scale; every key of every scale becomes one candidate class. */
const PREFIX: Record<string, string> = {
  spacing: "p",
  borderRadius: "rounded",
  borderWidth: "border",
  outlineWidth: "outline",
  boxShadow: "shadow",
  opacity: "opacity",
  zIndex: "z",
  fontFamily: "font",
  fontWeight: "font",
  fontSize: "text",
  transitionDuration: "duration",
  transitionTimingFunction: "ease",
  height: "h",
  minHeight: "min-h",
  minWidth: "min-w",
  width: "w",
  maxWidth: "max-w",
  size: "size",
};

function colorPaths(scale: Scale, prefix = ""): string[] {
  return Object.entries(scale).flatMap(([key, value]) => {
    const name = key === "DEFAULT" ? prefix : prefix ? `${prefix}-${key}` : key;
    return typeof value === "string" ? [name] : colorPaths(value as Scale, name);
  });
}

function candidates(): string[] {
  const out = colorPaths(preset.theme["colors"] ?? {}).flatMap((c) => [
    `bg-${c}`,
    `text-${c}`,
    `border-${c}`,
  ]);
  const scales: [string, Scale][] = [
    ...Object.entries(preset.theme).filter(
      ([k]) => k !== "extend" && k !== "colors" && k !== "screens",
    ),
    ...Object.entries(preset.theme.extend),
  ];
  for (const [scale, values] of scales) {
    const prefix = PREFIX[scale];
    if (prefix === undefined) throw new Error(`No utility prefix for theme scale ${scale}`);
    for (const key of Object.keys(values))
      out.push(key === "DEFAULT" ? prefix : `${prefix}-${key}`);
  }
  for (const screen of Object.keys(preset.theme["screens"] ?? {})) out.push(`${screen}:p-12`);
  out.push("dark:bg-bg-raised");
  return out;
}

/** var(--name) references inside the compiled utilities layer, excluding Tailwind's own --tw-* plumbing. */
function utilityVars(css: string): Set<string> {
  const utilities = css.slice(css.indexOf("@layer utilities"), css.indexOf("@property"));
  return new Set(
    [...utilities.matchAll(/var\((--[\w-]+)/g)].flatMap((m) =>
      m[1] && !m[1].startsWith("--tw-") ? [m[1]] : [],
    ),
  );
}

function presetVars(value: unknown): string[] {
  if (typeof value === "string")
    return [...value.matchAll(/var\((--[\w-]+)\)/g)].flatMap((m) => (m[1] ? [m[1]] : []));
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(presetVars);
  return [];
}

/** CSS-escaped class selector, as Tailwind writes it (a leading digit becomes a hex escape). */
function selector(cls: string): string {
  return cls.replace(/:/g, "\\:").replace(/^(\d)/, (d) => `\\3${d} `);
}

let build: TokenBuild;
let tokenVars: Set<string>;
let css: string;
const classes = candidates();

beforeAll(async () => {
  build = buildTokens();
  tokenVars = declaredVars(build);
  const compiler = await compile(readFileSync(`${fixture}app.css`, "utf8"), {
    base: fixture,
    from: `${fixture}app.css`,
    onDependency: () => undefined,
  });
  css = compiler.build(classes);
});
afterAll(() => build.dispose());

describe("Tailwind preset on Tailwind 4.3.3 through @config", () => {
  it("references only variables the token build declares", () => {
    const missing = [...new Set(presetVars(preset.theme))].filter((v) => !tokenVars.has(v));
    expect(missing).toEqual([]);
  });

  it("generates a utility for every token scale entry", () => {
    const absent = classes.filter(
      (c) => ![" ", ":"].some((end) => css.includes(`.${selector(c)}${end}`)),
    );
    expect(absent).toEqual([]);
  });

  it("compiles utilities whose variables all exist in the token build", () => {
    const used = utilityVars(css);
    expect(used.size).toBeGreaterThan(100);
    expect([...used].filter((v) => !tokenVars.has(v))).toEqual([]);
  });

  it("maps the handoff name translation examples", () => {
    expect(css).toMatch(/\.bg-bg-canvas \{\s*background-color: var\(--color-bg-canvas\);/);
    expect(css).toMatch(/\.text-text-secondary \{\s*color: var\(--color-text-secondary\);/);
    expect(css).toMatch(/\.text-accent-text \{\s*color: var\(--color-accent-text\);/);
    expect(css).toMatch(
      /\.border-border-control \{\s*border-color: var\(--color-border-control\);/,
    );
    expect(css).toMatch(
      /\.border-stroke-accent \{[^}]*border-width: var\(--stroke-width-accent\);/,
    );
    expect(css).toMatch(/\.border-accent \{\s*border-color: var\(--color-accent-default\);/);
    expect(css).toMatch(
      /\.duration-fast \{[^}]*transition-duration: var\(--motion-duration-fast\);/,
    );
    expect(css).toMatch(/\.p-12 \{\s*padding: var\(--space-12\);/);
  });

  it("scopes the dark variant to the dark theme attribute", () => {
    expect(preset.darkMode).toEqual(["selector", '[data-theme="dark"]']);
    expect(css).toContain('.dark\\:bg-bg-raised:where([data-theme="dark"], [data-theme="dark"] *)');
  });
});
