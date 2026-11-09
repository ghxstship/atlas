import { readFileSync } from "node:fs";
import {
  frontmatterField,
  isDraftVersion,
  legalDocumentLinks,
  legalPlainText,
  parseLegalMarkdown,
  stripFrontmatter,
  type LegalBlock,
} from "@xos/ui/legal-text";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LEGAL_HISTORY, LEGAL_SLUGS, LEGAL_TEXT } from "../lib/legal-text.generated";

/**
 * The published legal text against legal/index.yaml (Section 14.4). test/routes.test.ts fails when
 * lib/legal-text.generated.ts drifts from the documents; this one checks what the generated module
 * holds and that the renderer loses nothing of it.
 */
const repo = new URL("../../../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, repo), "utf8");
const registry = (
  parse(read("legal/index.yaml")) as {
    documents: {
      slug: string;
      title: string;
      version: string;
      file: string;
      publish: string;
      history: { version: string; effective_date?: string; summary: string }[];
    }[];
  }
).documents;
const published = registry.filter((d) => d.publish === "public");

/** The source's words without Markdown's markers, to compare with what the parser kept. */
function sourceWords(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line))
    .map((line) =>
      (/^#{1,6}\s/.test(line)
        ? line.replace(/^#{1,6}\s+/, "")
        : line.replace(/^>\s?/, "").replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
      )
        .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
        .replaceAll("**", "")
        .replaceAll("`", "")
        .replaceAll("|", " ")
        .replace(/(?<![\p{L}\p{N}_])_([^_]+?)_(?![\p{L}\p{N}_])/gu, "$1"),
    )
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);
}

function ids(blocks: readonly LegalBlock[]): string[] {
  return blocks.flatMap((b) => {
    if (b.t === "heading") return [b.id];
    if (b.t === "p") return b.id ? [b.id] : [];
    if (b.t === "quote") return ids(b.c);
    if (b.t === "list") return b.items.flatMap((item) => ids(item.children));
    return [];
  });
}

function tables(blocks: readonly LegalBlock[]) {
  return blocks.filter((b): b is Extract<LegalBlock, { t: "table" }> => b.t === "table");
}

describe("the generated legal text", () => {
  it("holds every public document and no internal one", () => {
    expect(Object.keys(LEGAL_TEXT).sort()).toEqual(published.map((d) => d.slug).sort());
    expect(LEGAL_SLUGS).toEqual(published.map((d) => d.slug));
  });

  it.each(published)("$slug loses only its frontmatter", ({ slug, file }) => {
    expect(LEGAL_TEXT[slug]).toBe(stripFrontmatter(read(file)));
    expect(LEGAL_TEXT[slug]).not.toMatch(/^---/);
  });

  it.each(published)("$slug states the registry's version and keeps a draft notice", (doc) => {
    expect(/^version: (\S+)$/m.exec(read(doc.file))?.[1]).toBe(doc.version);
    if (doc.version.endsWith("-draft")) {
      expect(LEGAL_TEXT[doc.slug]).toMatch(/^> \*\*Draft/m);
    }
  });
});

describe("the version history /legal lists (Terms of Service 15)", () => {
  it("opens every document's history in the registry with its current version", () => {
    for (const doc of registry) {
      expect(doc.history[0]?.version, doc.slug).toBe(doc.version);
      for (const entry of doc.history) expect(entry.summary.trim(), doc.slug).not.toBe("");
    }
  });

  it("holds every public document's versions and no internal one's", () => {
    expect(Object.keys(LEGAL_HISTORY).sort()).toEqual(published.map((d) => d.slug).sort());
  });

  it.each(published)("$slug shows its effective date only once it is in effect", (doc) => {
    const [current, ...earlier] = LEGAL_HISTORY[doc.slug] ?? [];
    expect(current?.version).toBe(doc.version);
    expect(current?.effectiveDate).toBe(
      isDraftVersion(doc.version) ? null : frontmatterField(read(doc.file), "effective_date"),
    );
    for (const entry of earlier) expect(entry.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe.each(published)("rendering $slug", ({ slug, title }) => {
  const text = LEGAL_TEXT[slug] ?? "";
  const blocks = parseLegalMarkdown(text);

  it("keeps every word of the document", () => {
    expect(legalPlainText(blocks).split(/\s+/).filter(Boolean)).toEqual(sourceWords(text));
  });

  it("has the registry's title as its only top heading", () => {
    const top = blocks.flatMap((b) => (b.t === "heading" && b.level === 1 ? [b.v] : []));
    expect(top).toEqual([title]);
    expect(blocks[0]).toMatchObject({ t: "heading", level: 1 });
  });

  it("gives each anchor and each table region a name of its own", () => {
    const anchors = ids(blocks);
    expect(new Set(anchors).size).toBe(anchors.length);
    const labels = tables(blocks).map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("keeps every table row as wide as its header, and no header cell empty", () => {
    for (const table of tables(blocks)) {
      expect(table.head.every((cell) => cell.length > 0)).toBe(true);
      for (const row of table.rows) expect(row).toHaveLength(table.head.length);
    }
  });

  it("points only at documents that are published", () => {
    const known = new Set([...LEGAL_SLUGS, "cookie-settings"]);
    expect(legalDocumentLinks(blocks).filter((link) => !known.has(link))).toEqual([]);
  });
});
