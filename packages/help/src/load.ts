/**
 * Build-time only: reads a shell's help content directory with node:fs (see ./model for the
 * convention) and renders the generated modules the shells import. Each shell's generator test
 * calls these; no app bundle imports this file.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  ARTICLE_KINDS,
  coversNode,
  HELP_LOCALES,
  isSpecificTo,
  parseBody,
  type Article,
  type ArticleSummary,
  type HelpBodies,
  type HelpContent,
  type HelpGuides,
  type HelpIndex,
  type HelpLocale,
} from "./model";

const KEY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const NODE_PATTERN = /^(\*|[a-z][a-z0-9-]*(\.[a-z0-9-]+)*(\.\*)?)$/;

const frontmatter = z.strictObject({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(300),
  kind: z.enum(ARTICLE_KINDS),
  nodes: z.array(z.string().regex(NODE_PATTERN)),
  order: z.number().int().min(0),
});

/** Parses one article file: YAML frontmatter between `---` lines, then the Markdown body. */
export function parseArticle(slug: string, text: string): Article {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`Article ${slug} has no frontmatter.`);
  const meta = frontmatter.parse(parse(match[1] as string));
  return { slug, ...meta, body: parseBody(match[2] as string) };
}

const toursFile = z.strictObject({
  tours: z.array(
    z.strictObject({
      key: z.string().regex(KEY),
      nodes: z.array(z.string().regex(NODE_PATTERN)).min(1),
      steps: z.array(z.strictObject({ target: z.string().min(1).nullable() })).min(1),
    }),
  ),
});
const tipsFile = z.strictObject({
  tips: z.array(
    z.strictObject({
      key: z.string().regex(KEY),
      nodes: z.array(z.string().regex(NODE_PATTERN)).min(1),
      article: z.string().regex(KEY),
    }),
  ),
});
const whatsNewFile = z.strictObject({
  entries: z.array(
    z.strictObject({
      key: z.string().regex(KEY),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      article: z.string().regex(KEY).nullable().optional(),
    }),
  ),
});

/** Every article of every locale, sorted by slug. */
export function loadArticles(dir: string): Record<HelpLocale, Article[]> {
  return Object.fromEntries(
    HELP_LOCALES.map((locale) => {
      const folder = join(dir, "articles", locale);
      const list = readdirSync(folder)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => parseArticle(f.slice(0, -3), readFileSync(join(folder, f), "utf8")));
      return [locale, list];
    }),
  ) as Record<HelpLocale, Article[]>;
}

/** Reads every article, and the tours, tips and What's New entries a directory has. */
export function loadHelpContent(dir: string): HelpContent {
  const read = (name: string): unknown => {
    const file = join(dir, name);
    return existsSync(file) ? (parse(readFileSync(file, "utf8")) as unknown) : null;
  };
  const tours = read("tours.yaml");
  const tips = read("tips.yaml");
  const whatsNew = read("whats-new.yaml");
  return {
    articles: loadArticles(dir),
    tours: tours === null ? [] : toursFile.parse(tours).tours,
    tips: tips === null ? [] : tipsFile.parse(tips).tips,
    whatsNew:
      whatsNew === null
        ? []
        : whatsNewFile
            .parse(whatsNew)
            .entries.map((e) => ({ key: e.key, date: e.date, article: e.article ?? null })),
  };
}

/** An article without its body. */
export function summaryOf(a: Article): ArticleSummary {
  return {
    slug: a.slug,
    title: a.title,
    summary: a.summary,
    kind: a.kind,
    nodes: a.nodes,
    order: a.order,
  };
}

/** A generated module: the header lines, a type import and one exported constant. */
export function renderModule(
  header: readonly string[],
  typeName: string,
  typeSource: string,
  exportName: string,
  value: unknown,
): string {
  return [
    ...header,
    `import type { ${typeName} } from "${typeSource}";`,
    "",
    `export const ${exportName}: ${typeName} = ${JSON.stringify(value)};`,
    "",
  ].join("\n");
}

/** The help index: everything but the article bodies (HELP_CONTENT). */
export function renderHelpModule(
  content: HelpContent,
  header: readonly string[],
  typeSource = "./model",
): string {
  const index: HelpIndex = {
    ...content,
    articles: Object.fromEntries(
      HELP_LOCALES.map((l) => [l, content.articles[l].map(summaryOf)]),
    ) as unknown as HelpIndex["articles"],
  };
  return renderModule(header, "HelpIndex", typeSource, "HELP_CONTENT", index);
}

/** The tours and tips alone (HELP_GUIDES). */
export function renderHelpGuides(
  content: HelpContent,
  header: readonly string[],
  typeSource = "./model",
): string {
  const guides: HelpGuides = { tours: content.tours, tips: content.tips };
  return renderModule(header, "HelpGuides", typeSource, "HELP_GUIDES", guides);
}

/** The article bodies by locale and slug (HELP_BODIES). */
export function renderHelpBodies(
  content: HelpContent,
  header: readonly string[],
  typeSource = "./model",
): string {
  const bodies: HelpBodies = Object.fromEntries(
    HELP_LOCALES.map((l) => [
      l,
      Object.fromEntries(content.articles[l].map((a) => [a.slug, a.body])),
    ]),
  ) as HelpBodies;
  return renderModule(header, "HelpBodies", typeSource, "HELP_BODIES", bodies);
}

/**
 * What is wrong with a shell's help content, as readable lines (empty when nothing is): an article
 * missing from a locale or differing in its pages, a node pattern that names no node, a `help:` link
 * to an article that does not exist, and tours, tips or What's New entries naming unknown nodes or
 * articles.
 */
export function helpProblems(content: HelpContent, nodeIds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const shape = (a: Article) => `${a.slug}|${a.kind}|${a.order}|${a.nodes.join(",")}`;
  const [first, ...rest] = HELP_LOCALES;
  const reference = content.articles[first].map(shape);
  for (const locale of rest) {
    const other = content.articles[locale].map(shape);
    for (const s of reference) if (!other.includes(s)) problems.push(`${locale} lacks ${s}`);
    for (const s of other) if (!reference.includes(s)) problems.push(`${first} lacks ${s}`);
  }
  const valid = (p: string) =>
    p === "*" || (p.endsWith(".*") ? [...nodeIds].some((id) => coversNode(p, id)) : nodeIds.has(p));
  const slugs = new Set(content.articles[first].map((a) => a.slug));
  for (const locale of HELP_LOCALES) {
    for (const article of content.articles[locale]) {
      for (const p of article.nodes) {
        if (!valid(p)) problems.push(`${locale}/${article.slug}: no node ${p}`);
      }
      const inlines = article.body.flatMap((b) =>
        "c" in b ? b.c : "items" in b ? b.items.flat() : [],
      );
      for (const link of inlines) {
        if (link.t === "link" && link.href.startsWith("help:") && !slugs.has(link.href.slice(5))) {
          problems.push(`${locale}/${article.slug}: no article ${link.href}`);
        }
      }
    }
  }
  for (const item of [...content.tours, ...content.tips]) {
    for (const p of item.nodes) if (!valid(p)) problems.push(`${item.key}: no node ${p}`);
  }
  for (const tip of content.tips) {
    if (!slugs.has(tip.article)) problems.push(`${tip.key}: no article ${tip.article}`);
  }
  for (const entry of content.whatsNew) {
    if (entry.article && !slugs.has(entry.article)) {
      problems.push(`${entry.key}: no article ${entry.article}`);
    }
  }
  return problems;
}

/** The nodes no article helps with specifically (general "*" articles do not count). */
export function uncoveredNodes(
  articles: readonly ArticleSummary[],
  nodeIds: Iterable<string>,
): string[] {
  return [...nodeIds].filter((id) => !articles.some((a) => isSpecificTo(a, id)));
}
