import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";
import enHelp from "../../../packages/i18n/messages/en-US/help.json";
import esHelp from "../../../packages/i18n/messages/es-US/help.json";
import {
  loadHelpContent,
  parseArticle,
  renderHelpBodies,
  renderHelpGuides,
  renderHelpModule,
} from "../help/load";
import {
  articlesForNode,
  coversNode,
  forNode,
  HELP_LOCALES,
  parseBody,
  parseInline,
  searchArticles,
  type Article,
} from "../help/model";
import { flattenRoutes } from "@xos/ia";
import { sitemap } from "../ia/sitemap.generated";

/**
 * The help content (Section 11.16). Runs with XOS_WRITE_GENERATED=1 to write
 * help/content.generated.ts and help/bodies.generated.ts; every other run fails on drift. Also checks that every article exists
 * in every locale, names real pages, and links only to articles that exist, and that every tour,
 * tip and What's New entry has its copy.
 */
const content = loadHelpContent();
const target = fileURLToPath(new URL("../help/content.generated.ts", import.meta.url));
const bodiesTarget = fileURLToPath(new URL("../help/bodies.generated.ts", import.meta.url));
const guidesTarget = fileURLToPath(new URL("../help/guides.generated.ts", import.meta.url));
const formatted = async (source: string, file: string) =>
  format(source, { ...((await resolveConfig(file)) ?? {}), filepath: file });
const expected = await formatted(renderHelpModule(content), target);
const expectedBodies = await formatted(renderHelpBodies(content), bodiesTarget);
const expectedGuides = await formatted(renderHelpGuides(content), guidesTarget);
if (process.env["XOS_WRITE_GENERATED"] === "1") {
  writeFileSync(target, expected);
  writeFileSync(bodiesTarget, expectedBodies);
  writeFileSync(guidesTarget, expectedGuides);
}

function nodeIds(): Set<string> {
  const ids = new Set<string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as { id?: unknown };
    if (typeof n.id === "string") ids.add(n.id);
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk);
  };
  walk(sitemap);
  return ids;
}

const ids = nodeIds();
const validPattern = (p: string) =>
  p === "*" || (p.endsWith(".*") ? [...ids].some((id) => coversNode(p, id)) : ids.has(p));

const lookup = (catalog: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], catalog);

describe("help content", () => {
  it("matches the generated module", () => {
    expect(existsSync(target) ? readFileSync(target, "utf8") : "").toBe(expected);
    expect(existsSync(bodiesTarget) ? readFileSync(bodiesTarget, "utf8") : "").toBe(expectedBodies);
    expect(existsSync(guidesTarget) ? readFileSync(guidesTarget, "utf8") : "").toBe(expectedGuides);
  });

  it("keeps article bodies out of the index the shell loads on every page", () => {
    expect(expected).not.toContain('"body"');
    expect(expected).not.toMatch(/\bbody:/);
  });

  it("has every article in every locale with the same pages", () => {
    const shape = (a: Article) => `${a.slug}|${a.kind}|${a.order}|${a.nodes.join(",")}`;
    const [first, ...rest] = HELP_LOCALES;
    for (const locale of rest) {
      expect(content.articles[locale].map(shape)).toEqual(content.articles[first].map(shape));
    }
    expect(content.articles["en-US"].length).toBeGreaterThanOrEqual(20);
  });

  it("names only pages in the sitemap and links only to articles that exist", () => {
    const slugs = new Set(content.articles["en-US"].map((a) => a.slug));
    for (const locale of HELP_LOCALES) {
      for (const article of content.articles[locale]) {
        for (const p of article.nodes) expect(validPattern(p), `${article.slug}: ${p}`).toBe(true);
        const links = article.body.flatMap((b) =>
          "c" in b ? b.c : "items" in b ? b.items.flat() : [],
        );
        for (const link of links) {
          if (link.t === "link" && link.href.startsWith("help:")) {
            expect(slugs.has(link.href.slice(5)), `${article.slug}: ${link.href}`).toBe(true);
          }
        }
      }
    }
    for (const item of [...content.tours, ...content.tips]) {
      for (const p of item.nodes) expect(validPattern(p), `${item.key}: ${p}`).toBe(true);
    }
    for (const tip of content.tips) expect(slugs.has(tip.article)).toBe(true);
    for (const entry of content.whatsNew) {
      if (entry.article) expect(slugs.has(entry.article)).toBe(true);
    }
  });

  // Gate 31: every signed-in page has help of its own, not only the general articles. Public and
  // token pages carry no help panel.
  it("gives every signed-in page an article of its own", () => {
    const missing = flattenRoutes(sitemap)
      .filter((r) => r.auth === "session")
      .filter(
        (r) =>
          !content.articles["en-US"].some((a) =>
            a.nodes.some((p) => p !== "*" && coversNode(p, r.id)),
          ),
      )
      .map((r) => r.id);
    expect(missing).toEqual([]);
  });

  it("has copy for every tour step, tip and What's New entry in both locales", () => {
    for (const catalog of [enHelp, esHelp]) {
      for (const tour of content.tours) {
        const key = `tours.${tour.key.replaceAll(".", "_")}`;
        expect(lookup(catalog, `${key}.title`), key).toBeTypeOf("string");
        expect(lookup(catalog, `${key}.summary`), key).toBeTypeOf("string");
        tour.steps.forEach((_, i) => {
          expect(lookup(catalog, `${key}.steps.${i + 1}.body`), `${key} ${i + 1}`).toBeTypeOf(
            "string",
          );
        });
      }
      for (const tip of content.tips) {
        expect(lookup(catalog, `tips.${tip.key}.body`), tip.key).toBeTypeOf("string");
      }
      for (const entry of content.whatsNew) {
        expect(lookup(catalog, `whatsNew.${entry.key}.title`), entry.key).toBeTypeOf("string");
      }
    }
  });
});

describe("help model", () => {
  it("parses the Markdown subset", () => {
    expect(
      parseBody(
        "## Head\n\nOne **two** `three`\nfour [five](help:x).\n\n- a\n- b\n\n1. c\n### Sub\ntext",
      ),
    ).toEqual([
      { t: "h2", v: "Head" },
      {
        t: "p",
        c: [
          { t: "text", v: "One " },
          { t: "strong", v: "two" },
          { t: "text", v: " " },
          { t: "code", v: "three" },
          { t: "text", v: " four " },
          { t: "link", v: "five", href: "help:x" },
          { t: "text", v: "." },
        ],
      },
      { t: "ul", items: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]] },
      { t: "ol", items: [[{ t: "text", v: "c" }]] },
      { t: "h3", v: "Sub" },
      { t: "p", c: [{ t: "text", v: "text" }] },
    ]);
    expect(parseBody("intro\n- item\nafter")).toEqual([
      { t: "p", c: [{ t: "text", v: "intro" }] },
      { t: "ul", items: [[{ t: "text", v: "item" }]] },
      { t: "p", c: [{ t: "text", v: "after" }] },
    ]);
    expect(parseInline("plain")).toEqual([{ t: "text", v: "plain" }]);
    expect(() => parseArticle("x", "no frontmatter")).toThrow(/frontmatter/);
  });

  it("orders page articles before general ones and searches", () => {
    const a = (slug: string, nodes: string[], order: number): Article => ({
      slug,
      title: slug,
      summary: `About ${slug}`,
      kind: "page",
      nodes,
      order,
      body: [{ t: "ul", items: [[{ t: "text", v: "zebra" }]] }],
    });
    const list = [
      a("general", ["*"], 1),
      a("crew", ["crew.*"], 5),
      a("shifts", ["crew.shifts"], 2),
    ];
    expect(articlesForNode(list, "crew.shifts").map((x) => x.slug)).toEqual([
      "shifts",
      "crew",
      "general",
    ]);
    expect(articlesForNode(list, null).map((x) => x.slug)).toEqual(["general"]);
    expect(searchArticles(list, "crew").map((x) => x.slug)).toEqual(["crew"]);
    expect(searchArticles(list, "zebra")).toHaveLength(3);
    expect(searchArticles(list, " ")).toEqual([]);
    expect(forNode([{ nodes: ["crew.*"] }], "crew.swaps")).toHaveLength(1);
    expect(forNode([{ nodes: ["crew.*"] }], null)).toHaveLength(0);
  });
});
