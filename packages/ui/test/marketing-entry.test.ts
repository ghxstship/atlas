// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import enUSui from "@xos/i18n/messages/en-US/ui.json" with { type: "json" };
import esUSui from "@xos/i18n/messages/es-US/ui.json" with { type: "json" };
import enUSmarketing from "@xos/i18n/ui-cuts/en-US/marketing.json" with { type: "json" };
import esUSmarketing from "@xos/i18n/ui-cuts/es-US/marketing.json" with { type: "json" };
import enUSmk from "@xos/i18n/ui/en-US/mk.json" with { type: "json" };
import tailwind from "@tailwindcss/postcss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flattenMessages } from "../src/marketing.ts";

/**
 * What a public page ships when it renders only the Marketing layer (lockstep issue 123):
 * `@xos/ui/marketing/styles.css` compiles the utilities of the Marketing components and nothing of
 * the product components, and `@xos/i18n/ui-cuts/<locale>/marketing.json` holds every `ui` message
 * group those components read. Both are held to the imports of src/marketing.ts, so neither list
 * can fall behind the code.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "src");
const stylesDir = join(src, "styles");
const entry = join(stylesDir, "marketing-only.css");

/** Every module a page reaches from `@xos/ui/marketing` or from a file of src/Marketing. */
function reached(): string[] {
  const seen = new Set<string>();
  const queue = [
    join(src, "marketing.ts"),
    ...readdirSync(join(src, "Marketing")).map((file) => join(src, "Marketing", file)),
  ];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    // `import type` and `export type` lines leave no import behind; every other line does.
    for (const match of text.matchAll(
      /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s*"(\.[^"]+)"/g,
    )) {
      queue.push(resolve(dirname(file), match[1] ?? ""));
    }
  }
  return [...seen].map((file) => relative(src, file)).sort();
}

const modules = reached();
const outside = modules.filter((file) => !file.startsWith("Marketing/") && file !== "marketing.ts");

describe("@xos/ui/marketing/styles.css scans exactly what the Marketing layer imports", () => {
  const sheet = readFileSync(entry, "utf8");
  const sources = [...sheet.matchAll(/^@source "\.\.\/([^"]+)";$/gm)].map((m) => m[1] ?? "");

  it("reaches modules outside src/Marketing, and each one exists", () => {
    expect(outside.length).toBeGreaterThan(10);
    expect(outside.filter((file) => !existsSync(join(src, file)))).toEqual([]);
  });

  it("names src/Marketing and then every module those components import, one file each", () => {
    expect(sources).toEqual(["Marketing", ...outside]);
  });

  it("loads the tokens, base rules, component rules and Marketing sheet the product entry loads", () => {
    const imports = (text: string) =>
      [...text.matchAll(/^@(?:import|config) [^;]+;$/gm)].map(String);
    const product = imports(readFileSync(join(stylesDir, "index.css"), "utf8"));
    expect(imports(sheet)).toEqual([...product, '@import "./marketing.css";']);
  });

  it("is exported as @xos/ui/marketing/styles.css", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports["./marketing/styles.css"]).toBe("./src/styles/marketing-only.css");
  });
});

const PAGE = 'export const Page = () => <main className="xos-mkt-wrap underline" />;\n';

describe("a page compiled through @tailwindcss/postcss", () => {
  // postcss is a dependency of the Tailwind plugin, not of this package, so it resolves from there.
  const requireFromPlugin = createRequire(
    createRequire(import.meta.url).resolve("@tailwindcss/postcss"),
  );
  const postcss = requireFromPlugin("postcss") as (plugins: unknown[]) => {
    process: (css: string, options: { from: string }) => Promise<{ css: string }>;
  };
  /** The consuming site: one page of its own, away from this package, as an installed copy is. */
  const site = mkdtempSync(join(tmpdir(), "xos-marketing-entry-"));
  const build = async (imports: string[]) => {
    const from = join(site, "app.css");
    const css = imports.map((file) => `@import ${JSON.stringify(file)};`).join("\n");
    return (await postcss([tailwind({ base: site, optimize: false })]).process(css, { from })).css;
  };
  /** The class names a sheet has rules for, as a component writes them. */
  const classes = (css: string) =>
    new Set(
      [...css.matchAll(/(?:^|[\s,{}>+~)])\.((?:\\[0-9a-f]{1,6} ?|\\.|[\w-])+)/g)].map((m) =>
        (m[1] ?? "")
          .replace(/\\([0-9a-f]{1,6}) ?/g, (_, hex: string) =>
            String.fromCodePoint(parseInt(hex, 16)),
          )
          .replace(/\\(.)/g, "$1"),
      ),
    );
  /** Classes the hand-written sheets define: both entries load those sheets whole. */
  const written = classes(
    ["base.css", "components.css", "marketing.css"]
      .map((file) => readFileSync(join(stylesDir, file), "utf8"))
      .join("\n"),
  );
  const texts = [...modules.map((file) => readFileSync(join(src, file), "utf8")), PAGE];
  /** The tokens the Marketing modules and the page write between white space and quotes: their classes. */
  const quoted = new Set(texts.flatMap((text) => text.split(/[\s"'`]+/)));
  /**
   * Every token Tailwind could read as a class there: the same, split again at each character a
   * plain word cannot hold (the scanner reads the `filter` of `.filter(` as the utility).
   */
  const tokens = new Set([...quoted, ...texts.flatMap((text) => text.split(/[^\w-]+/))]);

  let marketing = "";
  let product = "";

  beforeAll(async () => {
    writeFileSync(join(site, "page.tsx"), PAGE);
    marketing = await build([entry]);
    product = await build([join(stylesDir, "index.css"), join(stylesDir, "marketing.css")]);
  }, 120_000);

  afterAll(() => rmSync(site, { recursive: true, force: true }));

  it("compiles every utility the product entry compiles for the Marketing modules", () => {
    // The product entry scans all of src, so its sheet holds every rule the Marketing layer needs.
    const have = classes(marketing);
    const owed = [...classes(product)].filter((cls) => quoted.has(cls));
    expect(owed.length).toBeGreaterThan(100);
    expect(owed.filter((cls) => !have.has(cls))).toEqual([]);
  });

  it("compiles nothing the product entry does not", () => {
    const all = classes(product);
    expect([...classes(marketing)].filter((cls) => !all.has(cls))).toEqual([]);
  });

  it("keeps the site's own classes and the Marketing sheet", () => {
    expect(marketing).toContain(".underline");
    expect(marketing).toContain(".xos-mkt-wrap");
    expect(marketing).toContain(".xos-mkt-display-64");
    expect(marketing).toContain('[data-theme="sunlight"]');
  });

  it("omits the utilities only product components use, and is under two thirds of the product sheet", () => {
    const have = classes(marketing);
    const productOnly = [...classes(product)].filter(
      (cls) => !tokens.has(cls) && !written.has(cls),
    );
    expect(productOnly.length).toBeGreaterThan(500);
    expect(productOnly.filter((cls) => have.has(cls))).toEqual([]);
    expect(marketing.length).toBeLessThan((product.length * 2) / 3);
    console.info(
      `marketing entry ${marketing.length} bytes, product entry with the Marketing sheet ${product.length} bytes, ${productOnly.length} product-only classes omitted`,
    );
  });
});

describe("the marketing cut of the ui namespace", () => {
  const source = (file: string) =>
    readFileSync(join(src, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "");
  const keys = new Set(Object.keys(flattenMessages(enUSui)));

  /** The message groups the Marketing modules read: every string in them that is a `ui` key. */
  const read = new Set<string>();
  const templated: string[] = [];
  for (const file of modules) {
    const text = source(file);
    for (const match of text.matchAll(/["'`]([a-zA-Z][a-zA-Z0-9]*(?:\.[A-Za-z0-9_]+)+)["'`]/g)) {
      if (keys.has(match[1] ?? "")) read.add((match[1] ?? "").split(".")[0] ?? "");
    }
    // A key built from a template would escape the scan above, so none may exist.
    for (const match of text.matchAll(/\bt\(\s*`[^`]*\$\{/g))
      templated.push(`${file}: ${match[0]}`);
  }

  it("finds the keys by scanning, with no key built from a template", () => {
    expect(read.has("mk")).toBe(true);
    expect(templated).toEqual([]);
  });

  it("holds exactly the groups the Marketing modules read, in both launch locales", () => {
    expect(Object.keys(enUSmarketing)).toEqual([...read].sort());
    expect(Object.keys(esUSmarketing)).toEqual([...read].sort());
  });

  it("holds each group as ui.json does", () => {
    const en: Record<string, unknown> = enUSui;
    const es: Record<string, unknown> = esUSui;
    for (const [group, messages] of Object.entries(enUSmarketing))
      expect(messages).toEqual(en[group]);
    for (const [group, messages] of Object.entries(esUSmarketing))
      expect(messages).toEqual(es[group]);
    expect(enUSmk).toEqual({ mk: en["mk"] });
  });

  it("is a small part of the whole namespace", () => {
    expect(JSON.stringify(enUSmarketing).length).toBeLessThan(JSON.stringify(enUSui).length / 4);
  });
});
