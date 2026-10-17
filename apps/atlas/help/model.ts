/**
 * The help content model (Section 11.16). Help content lives in apps/atlas/help:
 *
 *   articles/<locale>/<slug>.md   one article per page or workflow, with frontmatter:
 *     title, summary   plain text
 *     kind             guide | page | workflow | glossary
 *     nodes            sitemap node ids the article helps with: an exact id, a prefix pattern such as
 *                      "settings.*", or "*" for every page (general articles listed after the page's own)
 *     order            position among the articles of a page, ascending
 *   tours.yaml          guided tours: key, the nodes they are offered on, and their steps (copy in the
 *                       help catalog namespace, help.tours.<key>)
 *   tips.yaml           contextual tips: key, the nodes they appear on, and the article they link to
 *   whats-new.yaml      dated release notes (copy in help.whatsNew.<key>)
 *
 * Articles are written in a small Markdown subset (## and ### headings, paragraphs, - and 1. lists,
 * **bold**, `code` and [links](href), where `help:<slug>` links to another article). The generator
 * test (test/help.test.ts, XOS_WRITE_GENERATED=1) parses everything into content.generated.ts (the
 * index: articles without bodies, tours, tips and What's New) and bodies.generated.ts (article
 * bodies), which the help panel loads only when it opens (A24-009) and renders without HTML strings. Every article exists in every locale. A20's apps/docs
 * help center reads the same files.
 */

export const HELP_LOCALES = ["en-US", "es-US"] as const;
export type HelpLocale = (typeof HELP_LOCALES)[number];
export const ARTICLE_KINDS = ["guide", "page", "workflow", "glossary"] as const;
export type ArticleKind = (typeof ARTICLE_KINDS)[number];

export type Inline =
  | { readonly t: "text"; readonly v: string }
  | { readonly t: "strong"; readonly v: string }
  | { readonly t: "code"; readonly v: string }
  | { readonly t: "link"; readonly v: string; readonly href: string };

export type Block =
  | { readonly t: "h2"; readonly v: string }
  | { readonly t: "h3"; readonly v: string }
  | { readonly t: "p"; readonly c: readonly Inline[] }
  | { readonly t: "ul"; readonly items: readonly (readonly Inline[])[] }
  | { readonly t: "ol"; readonly items: readonly (readonly Inline[])[] };

export interface Article {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly kind: ArticleKind;
  readonly nodes: readonly string[];
  readonly order: number;
  readonly body: readonly Block[];
}

export interface Tour {
  readonly key: string;
  readonly nodes: readonly string[];
  /** One entry per step: an optional CSS selector the step points at. */
  readonly steps: readonly { readonly target: string | null }[];
}

export interface Tip {
  readonly key: string;
  readonly nodes: readonly string[];
  readonly article: string;
}

export interface WhatsNewEntry {
  readonly key: string;
  readonly date: string;
  readonly article: string | null;
}

/** An article without its body, as the help index carries it. */
export type ArticleSummary = Omit<Article, "body">;

/** What the shell loads with every page: everything but the article bodies. */
export interface HelpIndex {
  readonly articles: Readonly<Record<HelpLocale, readonly ArticleSummary[]>>;
  readonly tours: readonly Tour[];
  readonly tips: readonly Tip[];
  readonly whatsNew: readonly WhatsNewEntry[];
}

/** Article bodies by locale and slug, loaded when the help panel opens. */
export type HelpBodies = Readonly<Record<HelpLocale, Readonly<Record<string, readonly Block[]>>>>;

export interface HelpContent {
  readonly articles: Readonly<Record<HelpLocale, readonly Article[]>>;
  readonly tours: readonly Tour[];
  readonly tips: readonly Tip[];
  readonly whatsNew: readonly WhatsNewEntry[];
}

/** Parses inline Markdown: **bold**, `code` and [text](href). */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index;
    if (at > last) out.push({ t: "text", v: text.slice(last, at) });
    if (m[1] !== undefined) out.push({ t: "strong", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "code", v: m[2] });
    else out.push({ t: "link", v: m[3] as string, href: m[4] as string });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

/** Parses the article Markdown subset into blocks. */
export function parseBody(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { t: "ul" | "ol"; items: Inline[][] } | null = null;
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ t: "p", c: parseInline(paragraph.join(" ")) });
    paragraph = [];
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const heading = /^(#{2,3}) (.+)$/.exec(line);
    const bullet = /^- (.+)$/.exec(line);
    const numbered = /^\d+\. (.+)$/.exec(line);
    if (line === "") flush();
    else if (heading) {
      flush();
      blocks.push({ t: heading[1] === "##" ? "h2" : "h3", v: heading[2] as string });
    } else if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      if (paragraph.length > 0 || (list && list.t !== kind)) flush();
      list ??= { t: kind, items: [] };
      list.items.push(parseInline((bullet ?? numbered)?.[1] as string));
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/** Whether an article's node pattern covers a sitemap node. */
export function coversNode(pattern: string, nodeId: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return nodeId.startsWith(pattern.slice(0, -1));
  return pattern === nodeId;
}

/**
 * The articles for a page: those naming the node (or a prefix of it) first, in their order, then the
 * general articles ("*"). An unknown page gets the general articles only.
 */
export function articlesForNode<A extends ArticleSummary>(
  articles: readonly A[],
  nodeId: string | null,
): A[] {
  const specific = articles.filter(
    (a) => nodeId !== null && a.nodes.some((p) => p !== "*" && coversNode(p, nodeId)),
  );
  const general = articles.filter((a) => a.nodes.includes("*") && !specific.includes(a));
  const byOrder = (x: A, y: A) => x.order - y.order;
  return [...specific.sort(byOrder), ...general.sort(byOrder)];
}

/**
 * Case-insensitive search over titles, summaries and, once the bodies are loaded, body text.
 * `bodyOf` returns an article's body, or nothing while the bodies are still loading.
 */
export function searchArticles<A extends ArticleSummary>(
  articles: readonly A[],
  query: string,
  bodyOf: (a: A) => readonly Block[] | undefined = (a) => (a as Partial<Article>).body,
): A[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const text = (a: A) =>
    [
      a.title,
      a.summary,
      ...(bodyOf(a) ?? []).flatMap((b) =>
        "v" in b ? [b.v] : "c" in b ? b.c.map((i) => i.v) : b.items.flat().map((i) => i.v),
      ),
    ]
      .join(" ")
      .toLowerCase();
  return articles
    .map((a) => ({
      a,
      title: a.title.toLowerCase().includes(needle),
      any: text(a).includes(needle),
    }))
    .filter((x) => x.any)
    .sort((x, y) => Number(y.title) - Number(x.title) || x.a.order - y.a.order)
    .map((x) => x.a);
}

/** Tours and tips offered on a page. */
export function forNode<T extends { readonly nodes: readonly string[] }>(
  items: readonly T[],
  nodeId: string | null,
): T[] {
  return nodeId === null ? [] : items.filter((i) => i.nodes.some((p) => coversNode(p, nodeId)));
}
