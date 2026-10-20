import { describe, expect, it } from "vitest";
import { PlanError } from "../../src/translation/icu.ts";
import { planMarkdown, planText, yamlScalar } from "../../src/translation/markdown.ts";
import { compileProtector } from "../../src/translation/protect.ts";
import { fakeTranslate } from "./fixture.ts";

const protector = compileProtector({
  terms: [{ term: "Atlas" }],
  patterns: [{ name: "URL", pattern: "https?://[^\\s<>\"'{}]*[^\\s<>\"'{}.,;:!?)\\]]" }],
});
const protect = (text: string) => protector.ranges(text, "help/intro.md");

const ARTICLE = [
  "---",
  "title: Intro",
  "summary: Start here.",
  "kind: guide",
  "nodes: [home, project.gates]",
  "order: 1",
  "---",
  "",
  "## First steps",
  "",
  "Open Atlas and use the `xos` CLI, see [the terms](https://example.com/terms) and **Save**.",
  "",
  "- Run `xos auth login` first.",
  "",
  "| Step | What |",
  "| ---- | ---- |",
  "| Save | Read the terms |",
  "",
  "```bash",
  "xos auth login   # Save the key",
  "```",
  "",
].join("\n");

describe("planMarkdown", () => {
  const plan = planMarkdown(ARTICLE, protect, { frontMatter: ["title", "summary"] });

  it("makes one segment per prose line, table cell and translated front matter value", () => {
    expect(plan.segments.map((s) => s.html)).toEqual([
      "Intro",
      "Start here.",
      "First steps",
      'Open <span translate="no" id="m1">Atlas</span> and use the <span translate="no" id="m2">`xos`</span> CLI, see <span id="w3">the terms</span> and <span id="w4">Save</span>.',
      'Run <span translate="no" id="m5">`xos auth login`</span> first.',
      "Step",
      "What",
      "Save",
      "Read the terms",
    ]);
  });

  it("restores links, bold, code, protected words, code blocks and untranslated front matter", () => {
    const out = plan.assemble(plan.segments.map((s) => fakeTranslate(s.html)));
    expect(out.split("\n")).toEqual([
      "---",
      "title: Introducción",
      "summary: Empieza aquí.",
      "kind: guide",
      "nodes: [home, project.gates]",
      "order: 1",
      "---",
      "",
      "## Primeros pasos",
      "",
      "Abre Atlas and use the `xos` CLI, see [the términos](https://example.com/terms) and **Guardar**.",
      "",
      "- Ejecuta `xos auth login` first.",
      "",
      "| Step | What |",
      "| ---- | ---- |",
      "| Guardar | Lee los términos |",
      "",
      "```bash",
      "xos auth login   # Save the key",
      "```",
      "",
    ]);
  });

  it("returns the document unchanged, up to table padding, when nothing is translated", () => {
    expect(plan.assemble(plan.segments.map((s) => s.html))).toBe(ARTICLE);
  });

  it("quotes a translated front matter value that YAML would misread", () => {
    expect(yamlScalar("Paso 1: abrir", false)).toBe('"Paso 1: abrir"');
    expect(yamlScalar("Abrir", false)).toBe("Abrir");
    expect(yamlScalar("Abrir", true)).toBe('"Abrir"');
    const quoted = planMarkdown('---\ntitle: "Intro"\n---\n', protect, { frontMatter: ["title"] });
    expect(quoted.assemble(["Introducción: guía"])).toBe('---\ntitle: "Introducción: guía"\n---\n');
  });

  it("refuses output that lost a frozen span", () => {
    expect(() => plan.assemble(plan.segments.map(() => "texto"))).toThrow(PlanError);
  });
});

describe("planText", () => {
  it("translates each line of a plain text file and keeps protected words", () => {
    const plan = planText("Open Atlas\n\nSave\n", protect);
    expect(plan.segments.map((s) => s.html)).toEqual([
      'Open <span translate="no" id="m1">Atlas</span>',
      "Save",
    ]);
    expect(plan.assemble(plan.segments.map((s) => fakeTranslate(s.html)))).toBe(
      "Abre Atlas\n\nGuardar\n",
    );
  });
});
