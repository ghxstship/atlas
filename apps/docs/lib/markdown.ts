/**
 * The Markdown subset the docs site renders, parsed into a tree so pages render without HTML
 * strings. It is a superset of the help article subset (apps/atlas/help/model.ts), so help
 * articles and developer guides share one renderer:
 *
 *   frontmatter between --- lines (YAML)
 *   ## and ### headings, paragraphs, - and 1. lists, > notes
 *   fenced code blocks with a language, pipe tables with a header separator row
 *   inline **bold**, `code` and [text](href)
 *
 * Links: `help:<slug>`, `guide:<slug>` and `reference:<resource>` point inside the site.
 */
import { parse as parseYaml } from "yaml";

export type Inline =
  | { readonly t: "text"; readonly v: string }
  | { readonly t: "strong"; readonly v: string }
  | { readonly t: "code"; readonly v: string }
  | { readonly t: "link"; readonly v: string; readonly href: string };

export type Block =
  | { readonly t: "h2"; readonly v: string; readonly id: string }
  | { readonly t: "h3"; readonly v: string; readonly id: string }
  | { readonly t: "p"; readonly c: readonly Inline[] }
  | { readonly t: "note"; readonly c: readonly Inline[] }
  | { readonly t: "ul"; readonly items: readonly (readonly Inline[])[] }
  | { readonly t: "ol"; readonly items: readonly (readonly Inline[])[] }
  | { readonly t: "code"; readonly lang: string; readonly v: string }
  | {
      readonly t: "table";
      readonly head: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    };

export interface Document {
  readonly meta: Readonly<Record<string, unknown>>;
  readonly body: readonly Block[];
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "strong", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "code", v: m[2] });
    else out.push({ t: "link", v: m[3] as string, href: m[4] as string });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

/** A stable fragment id for a heading. */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

export function parseBody(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const used = new Set<string>();
  let paragraph: string[] = [];
  let list: { t: "ul" | "ol"; items: Inline[][] } | null = null;
  let note: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ t: "p", c: parseInline(paragraph.join(" ")) });
    if (note.length > 0) blocks.push({ t: "note", c: parseInline(note.join(" ")) });
    if (list) blocks.push(list as Block);
    paragraph = [];
    note = [];
    list = null;
  };
  const heading = (level: "h2" | "h3", text: string) => {
    let id = slugify(text) || "section";
    for (let n = 2; used.has(id); n++) id = `${slugify(text)}-${n}`;
    used.add(id);
    blocks.push(level === "h2" ? { t: "h2", v: text, id } : { t: "h3", v: text, id });
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const line = raw.trim();
    const fence = /^```([A-Za-z0-9_-]*)$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && (lines[i] as string).trim() !== "```"; i++)
        code.push(lines[i] as string);
      if (i >= lines.length) throw new Error("A code block is not closed with ```.");
      blocks.push({ t: "code", lang: fence[1] || "text", v: code.join("\n") });
      continue;
    }
    if (line.startsWith("|") && /^\|?\s*:?-{3,}/.test((lines[i + 1] ?? "").trim())) {
      flush();
      const head = cells(line).map(parseInline);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && (lines[i] as string).trim().startsWith("|"); i++) {
        rows.push(cells(lines[i] as string).map(parseInline));
      }
      i--;
      blocks.push({ t: "table", head, rows });
      continue;
    }
    const h = /^(#{2,3}) (.+)$/.exec(line);
    const bullet = /^- (.+)$/.exec(line);
    const numbered = /^\d+\. (.+)$/.exec(line);
    const quote = /^> ?(.*)$/.exec(line);
    if (line === "") flush();
    else if (h) {
      flush();
      heading(h[1] === "##" ? "h2" : "h3", h[2] as string);
    } else if (quote) {
      if (paragraph.length > 0 || list) flush();
      note.push(quote[1] as string);
    } else if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      if (paragraph.length > 0 || note.length > 0 || (list && list.t !== kind)) flush();
      list ??= { t: kind, items: [] };
      list.items.push(parseInline((bullet ?? numbered)?.[1] as string));
    } else {
      if (list || note.length > 0) flush();
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/** Splits YAML frontmatter from the body. */
export function parseDocument(source: string): Document {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source.replace(/\r\n/g, "\n"));
  if (!m) return { meta: {}, body: parseBody(source) };
  const meta = parseYaml(m[1] as string) as unknown;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new Error("Frontmatter must be a YAML mapping.");
  }
  return { meta: meta as Record<string, unknown>, body: parseBody(m[2] as string) };
}

/** Every link target in a body, for link checking. */
export function linksIn(body: readonly Block[]): string[] {
  const inlines = body.flatMap((b): readonly Inline[] => {
    if (b.t === "p" || b.t === "note") return b.c;
    if (b.t === "ul" || b.t === "ol") return b.items.flat();
    if (b.t === "table") return [...b.head.flat(), ...b.rows.flat(2)];
    return [];
  });
  return inlines
    .filter((i): i is Extract<Inline, { t: "link" }> => i.t === "link")
    .map((i) => i.href);
}

/** Plain text of a body, for search. */
export function textOf(body: readonly Block[]): string {
  return body
    .map((b) => {
      if (b.t === "h2" || b.t === "h3" || b.t === "code") return b.v;
      if (b.t === "p" || b.t === "note") return b.c.map((i) => i.v).join("");
      if (b.t === "ul" || b.t === "ol")
        return b.items.map((it) => it.map((i) => i.v).join("")).join(" ");
      return [...b.head, ...b.rows.flat()].map((c) => c.map((i) => i.v).join("")).join(" ");
    })
    .join(" ");
}
