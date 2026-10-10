// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "src");
const stylesDir = join(src, "styles");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sources = walk(src).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));

/** Comparison operands (`size === "lg"`) are values, not classes. */
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** String literals that hold class names: `className="..."` attributes and every literal passed to `cx(...)`. */
function classLiterals(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) return;
    else if (!ts.isCallExpression(node)) ts.forEachChild(node, collect);
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(sf) === "className" &&
      node.initializer !== undefined &&
      ts.isStringLiteral(node.initializer)
    ) {
      out.push(node.initializer.text);
    }
    if (ts.isCallExpression(node) && node.expression.getText(sf) === "cx") {
      node.arguments.forEach(collect);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Classes that only mark an element for a group or peer variant and emit no rule of their own. */
const MARKERS = new Set(["group", "peer"]);

const used = new Map<string, string>();
for (const file of sources) {
  for (const literal of classLiterals(file)) {
    for (const token of literal.split(/\s+/).filter(Boolean)) {
      if (!used.has(token)) used.set(token, relative(root, file));
    }
  }
}

/** A class selector as Tailwind writes it. */
function selector(cls: string): string {
  const escaped = cls.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  return `.${escaped.replace(/^(\d)/, (d) => `\\3${d} `)}`;
}

let css = "";

beforeAll(async () => {
  const entry = join(stylesDir, "index.css");
  const compiler = await compile(readFileSync(entry, "utf8"), {
    base: stylesDir,
    from: entry,
    onDependency: () => undefined,
  });
  css = compiler.build([...used.keys()]);
});

describe("component styles on Tailwind 4.3.3 with the token preset", () => {
  it("scans class names from the components", () => {
    expect(used.size).toBeGreaterThan(100);
  });

  it("compiles a rule for every class a component uses", () => {
    const missing = [...used]
      .filter(
        ([cls]) => !MARKERS.has(cls) && !cls.startsWith("group/") && !css.includes(selector(cls)),
      )
      .map(([cls, file]) => `${cls} (${file})`);
    expect(missing).toEqual([]);
  });

  it("loads the token variables for every theme", () => {
    expect(css).toContain("--color-bg-canvas");
    expect(css).toContain('[data-theme="light"]');
    expect(css).toContain('[data-theme="sunlight"]');
    expect(css).toContain("--space-12");
  });

  it("keeps the platform defaults: reduced motion, forced colors, coarse pointers and print", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("forced-colors: active");
    expect(css).toContain("pointer: coarse");
    expect(css).toContain("@media print");
  });

  it("defines every component dimension it reads", () => {
    const defined = new Set([...css.matchAll(/(--ui-[\w-]+)\s*:/g)].map((m) => m[1]));
    const read = new Set<string>();
    for (const file of sources) {
      for (const m of readFileSync(file, "utf8").matchAll(/(--ui-[\w-]+)/g)) read.add(m[1] ?? "");
    }
    expect([...read].filter((v) => !defined.has(v))).toEqual([]);
  });
});
