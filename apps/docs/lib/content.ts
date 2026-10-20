/**
 * Content loading, on the server only. Guides live in apps/docs/content/guides/<locale>/<slug>.md.
 * The help center reads each shell's help content in place (apps/atlas/help, apps/gateway/help and
 * apps/compass/help: articles/<locale>/*.md, and Atlas's whats-new.yaml), so in-app help and the
 * public help center never diverge (Section 11.16).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Locale } from "./i18n.ts";
import type { Block } from "./markdown.ts";
import { parseDocument } from "./markdown.ts";

/** apps/docs, whether run from the app directory (next) or the repository root (tests). */
export const APP_DIR = process.cwd().endsWith(join("apps", "docs"))
  ? process.cwd()
  : join(process.cwd(), "apps", "docs");
export const GUIDES_DIR = join(APP_DIR, "content", "guides");
export const HELP_DIR = join(APP_DIR, "..", "atlas", "help");

/** The shells whose help the help center publishes; Atlas articles keep the top-level paths. */
export const HELP_SHELLS = ["atlas", "gateway", "compass"] as const;
export type HelpShell = (typeof HELP_SHELLS)[number];

const HELP_DIRS: Readonly<Record<HelpShell, string>> = {
  atlas: HELP_DIR,
  gateway: join(APP_DIR, "..", "gateway", "help"),
  compass: join(APP_DIR, "..", "compass", "help"),
};

/** An article's path: /<locale>/help/<slug> for Atlas, /<locale>/help/<shell>/<slug> otherwise. */
export function helpPath(locale: Locale, shell: HelpShell, slug: string): string {
  return shell === "atlas" ? `/${locale}/help/${slug}` : `/${locale}/help/${shell}/${slug}`;
}

export interface Page {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly order: number;
  readonly body: readonly Block[];
}

export interface Guide extends Page {
  readonly section: "start" | "api" | "tools" | "operate";
}

export const GUIDE_SECTIONS = ["start", "api", "tools", "operate"] as const;

export interface HelpArticle extends Page {
  readonly kind: "guide" | "page" | "workflow" | "glossary";
}

export interface WhatsNew {
  readonly key: string;
  readonly date: string;
  readonly article: string | null;
}

function requireString(meta: Readonly<Record<string, unknown>>, key: string, file: string): string {
  const value = meta[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${file}: frontmatter needs ${key}.`);
  return value;
}

function readPages<T extends Page>(
  dir: string,
  build: (meta: Readonly<Record<string, unknown>>, file: string) => Omit<T, keyof Page>,
): T[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const file = join(dir, f);
      const { meta, body } = parseDocument(readFileSync(file, "utf8"));
      const order = meta["order"];
      return {
        slug: f.slice(0, -3),
        title: requireString(meta, "title", file),
        summary: requireString(meta, "summary", file),
        order: typeof order === "number" ? order : 999,
        body,
        ...build(meta, file),
      } as T;
    })
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

const cache = new Map<string, unknown>();
function cached<T>(key: string, load: () => T): T {
  if (!cache.has(key)) cache.set(key, load());
  return cache.get(key) as T;
}

export function guides(locale: Locale): Guide[] {
  return cached(`guides:${locale}`, () =>
    readPages<Guide>(join(GUIDES_DIR, locale), (meta, file) => {
      const section = requireString(meta, "section", file);
      if (!(GUIDE_SECTIONS as readonly string[]).includes(section))
        throw new Error(`${file}: unknown section ${section}.`);
      return { section: section as Guide["section"] };
    }),
  );
}

export function helpArticles(locale: Locale, shell: HelpShell = "atlas"): HelpArticle[] {
  return cached(`help:${shell}:${locale}`, () =>
    readPages<HelpArticle>(join(HELP_DIRS[shell], "articles", locale), (meta, file) => ({
      kind: requireString(meta, "kind", file) as HelpArticle["kind"],
    })),
  );
}

export function whatsNew(): WhatsNew[] {
  return cached("whats-new", () => {
    const doc = parseYaml(readFileSync(join(HELP_DIR, "whats-new.yaml"), "utf8")) as {
      entries?: WhatsNew[];
    };
    return (doc.entries ?? []).map((e) => ({
      key: e.key,
      date: String(e.date),
      article: e.article ?? null,
    }));
  });
}

/** Case-insensitive search; title matches rank first. */
export function searchPages<T extends Page>(
  pages: readonly T[],
  query: string,
  text: (p: T) => string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  return pages
    .map((p) => ({
      p,
      title: p.title.toLowerCase().includes(needle),
      any: `${p.title} ${p.summary} ${text(p)}`.toLowerCase().includes(needle),
    }))
    .filter((x) => x.any)
    .sort((x, y) => Number(y.title) - Number(x.title) || x.p.order - y.p.order)
    .map((x) => x.p);
}
