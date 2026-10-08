import { describe, expect, it } from "vitest";
import { getMessages } from "@xos/i18n";
import { indexSitemap } from "../src/index.ts";
import { loadApp } from "./support.ts";

function leaves(value: unknown, prefix: string): [string, string][] {
  if (typeof value === "string") return [[prefix, value]];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, `${prefix}.${k}`),
  );
}

const en = leaves(getMessages("en-US").nav, "nav");
const es = new Map(leaves(getMessages("es-US").nav, "nav"));
const MINOR = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "versus",
]);
const EM_DASH = String.fromCharCode(0x2014);

/** Title Case: every word capitalized except minor words after the first; acronyms allowed. */
function isTitleCase(text: string): boolean {
  return text.split(" ").every((word, i) =>
    word.split("-").every((part, j) => {
      if (i > 0 && j === 0 && MINOR.has(part)) return true;
      return /^[A-Z0-9]/.test(part);
    }),
  );
}

describe("nav labels", () => {
  it("are Title Case in en-US", () => {
    const offenders = en.filter(([, text]) => !isTitleCase(text));
    expect(offenders).toEqual([]);
  });

  it("use American English and no em dashes in either locale", () => {
    for (const [key, text] of [...en, ...es.entries()]) {
      expect(text, key).not.toContain(EM_DASH);
      expect(text, key).not.toMatch(/Cancelled|cancelled/);
      expect(text.trim(), key).toBe(text);
    }
  });

  it("start with a capital letter in es-US", () => {
    for (const [key, text] of es) expect(text, key).toMatch(/^[A-ZÁÉÍÓÚÑ]/);
  });

  it("are all used by a sitemap or breadcrumb", () => {
    const used = new Set<string>([
      "nav.breadcrumb.org",
      "nav.breadcrumb.workspace",
      "nav.breadcrumb.scope",
    ]);
    for (const app of ["atlas", "gateway", "compass"] as const) {
      const sitemap = loadApp(app);
      for (const entry of indexSitemap(sitemap).order) used.add(entry.node.label);
      for (const block of sitemap.contentBlocks ?? []) used.add(block.label);
    }
    expect(en.map(([key]) => key).filter((key) => !used.has(key))).toEqual([]);
  });
});

describe("Title Case check", () => {
  it("accepts minor words, hyphens and acronyms and refuses lowercase words", () => {
    expect(isTitleCase("Budget versus Actual")).toBe(true);
    expect(isTitleCase("Load-In and Load-Out Windows")).toBe(true);
    expect(isTitleCase("RFQs")).toBe(true);
    expect(isTitleCase("Gate readiness")).toBe(false);
    expect(isTitleCase("and More")).toBe(false);
  });
});
