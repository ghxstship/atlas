/**
 * The Markdown subset the legal documents are written in (legal/index.yaml), parsed to a tree the
 * page renders as plain elements, so no HTML string ever reaches the page. Pure: no Node and no
 * React, so a generator, a server component and a test all share it.
 */

export type LegalInline =
  | { readonly t: "text"; readonly v: string }
  | { readonly t: "strong" | "em"; readonly c: readonly LegalInline[] }
  | { readonly t: "code"; readonly v: string }
  /** A written link: http(s) or mailto only. */
  | { readonly t: "link"; readonly href: string; readonly c: readonly LegalInline[] }
  /** A path to another document as the text writes it, such as /legal/contact. */
  | { readonly t: "document"; readonly slug: string; readonly v: string }
  | { readonly t: "mail"; readonly v: string }
  /** "Section 3.6" where this document has that section. */
  | { readonly t: "section"; readonly id: string; readonly v: string };

export interface LegalListItem {
  readonly c: readonly LegalInline[];
  readonly children: readonly LegalBlock[];
}

export type LegalBlock =
  | {
      readonly t: "heading";
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly id: string;
      readonly v: string;
    }
  | { readonly t: "p"; readonly id?: string; readonly c: readonly LegalInline[] }
  | { readonly t: "quote"; readonly c: readonly LegalBlock[] }
  | {
      readonly t: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly LegalListItem[];
    }
  | {
      readonly t: "table";
      /** The accessible name of the table's scrolling region, unique on the page. */
      readonly label: string;
      readonly head: readonly (readonly LegalInline[])[];
      readonly rows: readonly (readonly (readonly LegalInline[])[])[];
    };

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n+/;

/** The document without its YAML frontmatter, and nothing else removed. */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER, "");
}

/** A version still in review: `1.0.0-draft` (legal/index.yaml). */
export function isDraftVersion(version: string): boolean {
  return version.endsWith("-draft");
}

const SECTION_NUMBER = /^(\d+(?:\.\d+)*)\.?\s/;
const CLAUSE = /^(\d+(?:\.\d+)+)\s/;
const LEADING_SPACE = /^\s*/;
const HEADING_HASHES = /^#{1,6}/;
const LIST_MARKER = /^(?:[-*+]|\d+\.)/;
const RULE_CELL = /^:?-+:?$/;

/*
 * Headings, list items and table rules are read in steps rather than by one pattern each: a single
 * pattern with neighbouring optional spaces (`\s+(.+?)\s*$`) backtracks over every way to split a
 * long run of spaces, so the time grows with the square of the line.
 */

/** `## Title`: [line, the hashes, the title trimmed], or null for any other line. */
function heading(line: string): [string, string, string] | null {
  const hashes = HEADING_HASHES.exec(line)?.[0];
  if (hashes === undefined) return null;
  const rest = line.slice(hashes.length);
  if (!LEADING_SPACE.exec(rest)?.[0]) return null;
  const title = rest.trim();
  return title === "" ? null : [line, hashes, title];
}

/** `- item` or `1. item`: [line, its indent, the marker, the text after it], or null. */
function listItem(line: string): [string, string, string, string] | null {
  const indent = LEADING_SPACE.exec(line)?.[0] ?? "";
  const marker = LIST_MARKER.exec(line.slice(indent.length))?.[0];
  if (marker === undefined) return null;
  const rest = line.slice(indent.length + marker.length);
  if (!LEADING_SPACE.exec(rest)?.[0]) return null;
  return [line, indent, marker, rest.trimStart()];
}

/** A table's rule line, `| --- | :-: |`: every cell between the pipes is dashes with optional colons. */
function isTableRule(line: string): boolean {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").every((cell) => RULE_CELL.test(cell.trim()));
}
const QUOTE = /^>\s?/;

/**
 * Bold, code, a written link, or underscore emphasis that opens and closes on a word edge. A link's label
 * and address stop at the next bracket or parenthesis, so a run of unclosed links reads in one pass.
 */
const INLINE =
  /\*\*(.+?)\*\*|`([^`]+)`|\[([^\][]+)\]\(([^()[\]\s]+)\)|(?<![\p{L}\p{N}_])_([^_]+?)_(?![\p{L}\p{N}_])/gu;

/**
 * A path to a document, an email address, or a section of this document. A section named with
 * another document ("Section 5 of the Security Overview", "Security Overview, Section 3") stays text.
 */
const AUTOLINK =
  /(?<![\w./-])(?:atlas\.ghxstship\.tech)?\/legal\/([a-z0-9-]+)|(?<![\w.+-])[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|(?<![A-Z][a-z]+, )\bSection (\d+(?:\.\d+)*)\b(?!\.\d| of\b)/g;

const SAFE_HREF = /^(https?:\/\/|mailto:)/;

function sectionId(number: string): string {
  return `section-${number.replaceAll(".", "-")}`;
}

function autolinks(text: string, sections: ReadonlySet<string>): LegalInline[] {
  const out: LegalInline[] = [];
  let last = 0;
  for (const m of text.matchAll(AUTOLINK)) {
    const [v, slug, section] = m;
    let node: LegalInline | null = null;
    if (slug !== undefined) node = { t: "document", slug, v };
    else if (section === undefined) node = { t: "mail", v };
    else if (sections.has(section)) node = { t: "section", id: sectionId(section), v };
    if (!node) continue;
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    out.push(node);
    last = m.index + v.length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

function parseInline(text: string, sections: ReadonlySet<string>): LegalInline[] {
  const out: LegalInline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(...autolinks(text.slice(last, m.index), sections));
    const [whole, strong, code, label, href, em] = m;
    if (strong !== undefined) out.push({ t: "strong", c: parseInline(strong, sections) });
    else if (code !== undefined) out.push({ t: "code", v: code });
    else if (em !== undefined) out.push({ t: "em", c: parseInline(em, sections) });
    else if (label !== undefined && href !== undefined && SAFE_HREF.test(href)) {
      out.push({ t: "link", href, c: parseInline(label, new Set()) });
    } else out.push(...parseInline(label ?? whole, sections));
    last = m.index + whole.length;
  }
  if (last < text.length) out.push(...autolinks(text.slice(last), sections));
  return out;
}

/** The text of an inline run, without its markup. */
export function inlineText(parts: readonly LegalInline[]): string {
  return parts.map((part) => ("c" in part ? inlineText(part.c) : part.v)).join("");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Splits a table row on its pipes; a pipe inside a code span or written as \| stays in the cell. */
function tableCells(line: string): string[] {
  const row = line.trim().replace(/^\|/, "");
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row.charAt(i);
    if (ch === "\\" && row.charAt(i + 1) === "|") {
      cell += "|";
      i += 1;
    } else if (ch === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      if (ch === "`") inCode = !inCode;
      cell += ch;
    }
  }
  if (cell.trim() !== "") cells.push(cell.trim());
  return cells;
}

interface Scope {
  readonly sections: ReadonlySet<string>;
  readonly ids: Set<string>;
  readonly labels: Set<string>;
  /** The nearest heading so far, which names a table that has no caption of its own. */
  heading: string;
}

function uniqueIn(used: Set<string>, wanted: string, join: (n: number) => string): string {
  let value = wanted;
  for (let n = 2; used.has(value); n += 1) value = join(n);
  used.add(value);
  return value;
}

function headingBlock(hashes: string, raw: string, scope: Scope): LegalBlock {
  const v = inlineText(parseInline(raw, new Set()));
  const number = SECTION_NUMBER.exec(v)?.[1];
  const wanted = (number ? sectionId(number) : slugify(v)) || "section";
  const id = uniqueIn(scope.ids, wanted, (n) => `${wanted}-${n}`);
  scope.heading = v;
  return { t: "heading", level: hashes.length as 1 | 2 | 3 | 4 | 5 | 6, id, v };
}

function paragraphBlock(text: string, scope: Scope): LegalBlock {
  const c = parseInline(text, scope.sections);
  const number = CLAUSE.exec(text)?.[1];
  const wanted = number ? sectionId(number) : undefined;
  if (wanted === undefined || scope.ids.has(wanted)) return { t: "p", c };
  scope.ids.add(wanted);
  return { t: "p", id: wanted, c };
}

function tableBlock(lines: readonly string[], scope: Scope): LegalBlock {
  const [head = "", , ...rows] = lines;
  const cells = (line: string) => tableCells(line).map((c) => parseInline(c, scope.sections));
  const label = uniqueIn(scope.labels, scope.heading, (n) => `${scope.heading} (${n})`);
  return { t: "table", label, head: cells(head), rows: rows.map(cells) };
}

/** A list and the lists nested in it, from `from`; returns the block and the next unread line. */
function listBlock(
  lines: readonly string[],
  from: number,
  scope: Scope,
): { block: LegalBlock; next: number } {
  const first = listItem(lines[from] ?? "");
  const indent = first?.[1]?.length ?? 0;
  const ordered = /\d/.test(first?.[2] ?? "");
  const items: { c: LegalInline[]; children: LegalBlock[] }[] = [];
  let i = from;
  let text: string | null = null;
  let nested: LegalBlock[] = [];
  const close = () => {
    if (text !== null) items.push({ c: parseInline(text, scope.sections), children: nested });
    text = null;
    nested = [];
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const item = listItem(line);
    if (line.trim() === "") {
      // A blank line ends the list unless the next line carries on with it.
      let peek = i + 1;
      while (peek < lines.length && (lines[peek] ?? "").trim() === "") peek += 1;
      const after = listItem(lines[peek] ?? "");
      const continues =
        after !== null &&
        ((after[1]?.length ?? 0) > indent ||
          ((after[1]?.length ?? 0) === indent && /\d/.test(after[2] ?? "") === ordered));
      if (!continues) break;
      i = peek;
    } else if (item) {
      const at = item[1]?.length ?? 0;
      if (at < indent) break;
      if (at > indent) {
        const inner = listBlock(lines, i, scope);
        nested.push(inner.block);
        i = inner.next;
      } else if (/\d/.test(item[2] ?? "") !== ordered) {
        break;
      } else {
        close();
        text = item[3] ?? "";
        i += 1;
      }
    } else if (startsBlock(lines, i)) {
      break;
    } else {
      // A line directly under an item continues that item.
      text = `${text ?? ""} ${line.trim()}`.trim();
      i += 1;
    }
  }
  close();
  const start = ordered ? Number.parseInt(first?.[2] ?? "1", 10) : 1;
  return { block: { t: "list", ordered, start, items }, next: i };
}

function startsTable(lines: readonly string[], i: number): boolean {
  return (lines[i] ?? "").includes("|") && isTableRule(lines[i + 1] ?? "");
}

function startsBlock(lines: readonly string[], i: number): boolean {
  const line = lines[i] ?? "";
  return (
    line.trim() === "" ||
    heading(line) !== null ||
    QUOTE.test(line) ||
    listItem(line) !== null ||
    startsTable(lines, i)
  );
}

function parseBlocks(lines: readonly string[], scope: Scope): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const title = heading(line);
    if (line.trim() === "") {
      i += 1;
    } else if (title) {
      blocks.push(headingBlock(title[1], title[2], scope));
      i += 1;
    } else if (QUOTE.test(line)) {
      const inner: string[] = [];
      for (; QUOTE.test(lines[i] ?? ""); i += 1) inner.push((lines[i] ?? "").replace(QUOTE, ""));
      blocks.push({ t: "quote", c: parseBlocks(inner, scope) });
    } else if (listItem(line) !== null) {
      const { block, next } = listBlock(lines, i, scope);
      blocks.push(block);
      i = next;
    } else if (startsTable(lines, i)) {
      const table: string[] = [];
      for (; (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== ""; i += 1) {
        table.push(lines[i] ?? "");
      }
      blocks.push(tableBlock(table, scope));
    } else {
      const text: string[] = [line.trim()];
      for (i += 1; i < lines.length && !startsBlock(lines, i); i += 1) {
        text.push((lines[i] ?? "").trim());
      }
      blocks.push(paragraphBlock(text.join(" "), scope));
    }
  }
  return blocks;
}

/** The section numbers a document's headings and numbered clauses give. */
function sectionNumbers(lines: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const line of lines) {
    const title = heading(line)?.[2];
    const number = title ? SECTION_NUMBER.exec(`${title} `)?.[1] : CLAUSE.exec(line)?.[1];
    if (number) found.add(number);
  }
  return found;
}

/**
 * The id of the version history that ends each page (LegalHistory). The parser keeps it out of a
 * document's own ids, so a heading of the document named Version History gets another one.
 */
export const LEGAL_HISTORY_ID = "version-history";

/** Parses a document's Markdown, with its frontmatter already stripped, into blocks. */
export function parseLegalMarkdown(markdown: string): LegalBlock[] {
  const lines = markdown.split(/\r?\n/);
  return parseBlocks(lines, {
    sections: sectionNumbers(lines),
    ids: new Set([LEGAL_HISTORY_ID]),
    labels: new Set(),
    heading: "",
  });
}

/** The plain text of parsed blocks, in reading order. */
export function legalPlainText(blocks: readonly LegalBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.t) {
        case "heading":
          return block.v;
        case "p":
          return inlineText(block.c);
        case "quote":
          return legalPlainText(block.c);
        case "list":
          return block.items
            .map((item) => `${inlineText(item.c)} ${legalPlainText(item.children)}`)
            .join(" ");
        case "table":
          return [block.head, ...block.rows]
            .map((row) => row.map((cell) => inlineText(cell)).join(" "))
            .join(" ");
      }
    })
    .join(" ");
}

/** Every /legal/{slug} a document's text points to. */
export function legalDocumentLinks(blocks: readonly LegalBlock[]): string[] {
  const inlines = (parts: readonly LegalInline[]): string[] =>
    parts.flatMap((part) =>
      part.t === "document" ? [part.slug] : "c" in part ? inlines(part.c) : [],
    );
  return blocks.flatMap((block) => {
    switch (block.t) {
      case "heading":
        return [];
      case "p":
        return inlines(block.c);
      case "quote":
        return legalDocumentLinks(block.c);
      case "list":
        return block.items.flatMap((i) => [...inlines(i.c), ...legalDocumentLinks(i.children)]);
      case "table":
        return [block.head, ...block.rows].flatMap((row) => row.flatMap((cell) => inlines(cell)));
    }
  });
}

/** One version of a document as legal/index.yaml records it under `history`, newest first. */
export interface LegalHistoryEntry {
  readonly version: string;
  /** The day the version took effect, YYYY-MM-DD. A draft has none. */
  readonly effective_date?: string;
  /** What changed in this version, in a sentence or two. */
  readonly summary: string;
}

/** One version of a document as its page lists it. */
export interface LegalVersion {
  readonly version: string;
  /** YYYY-MM-DD, or null while the version is a draft and so not in effect. */
  readonly effectiveDate: string | null;
  readonly summary: string;
}

/**
 * Where a version stands on a given day: a draft is never in effect, a final version is upcoming
 * until its effective date (the notice period of Terms of Service 15) and in effect from that day.
 */
export type LegalVersionState = "draft" | "upcoming" | "inEffect";

/** The UTC calendar day of `now`, YYYY-MM-DD, the clock the pages compare effective dates with. */
export function legalDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Where `version` stands on `today`, a YYYY-MM-DD day from legalDay. */
export function legalVersionState(version: LegalVersion, today: string): LegalVersionState {
  if (version.effectiveDate === null) return "draft";
  return version.effectiveDate > today ? "upcoming" : "inEffect";
}

/**
 * The newest version of `history` in effect on `today`, or undefined when none is yet. While the
 * current version is upcoming, this is the one that still applies until its date.
 */
export function legalVersionInEffect(
  history: readonly LegalVersion[],
  today: string,
): LegalVersion | undefined {
  return history.find((v) => legalVersionState(v, today) === "inEffect");
}

/** A document of the registry, as the text generator reads it. */
export interface LegalTextEntry {
  readonly slug: string;
  readonly file: string;
  readonly publish: string;
  /** The current version; the document's frontmatter states the same one. */
  readonly version: string;
  /** Every version, newest first; the first is the current one. */
  readonly history: readonly LegalHistoryEntry[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day written YYYY-MM-DD. */
function isIsoDate(value: string | undefined): value is string {
  if (value === undefined || !ISO_DATE.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value);
}

/** A field of the document's YAML frontmatter, unquoted, or undefined when it has none. */
export function frontmatterField(markdown: string, key: string): string | undefined {
  const front = FRONTMATTER.exec(markdown)?.[0] ?? "";
  const line = front.split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  const value = line?.slice(key.length + 1).trim();
  return value?.replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * The versions a document's page lists, newest first, checked against its text. The current version
 * comes first and matches the frontmatter's; only it may be a draft, and only while no version is
 * final, since the page serves one text and a draft would hide a final one. A new version of a
 * final document is final from the start, with an effective date far enough ahead for its notice;
 * the page calls it upcoming until then. A final version carries its effective date, and the
 * current one carries the day its frontmatter states. Throws on any mismatch, so the generator
 * cannot publish a page whose dates disagree with the document.
 */
export function legalVersions(entry: LegalTextEntry, markdown: string): LegalVersion[] {
  const fail = (problem: string): never => {
    throw new Error(`legal/index.yaml, ${entry.slug}: ${problem}`);
  };
  if (frontmatterField(markdown, "version") !== entry.version) {
    fail(`${entry.file} does not state version ${entry.version}`);
  }
  const { history } = entry;
  if (history[0]?.version !== entry.version) {
    fail(`history must open with the current version, ${entry.version}`);
  }
  if (new Set(history.map((h) => h.version)).size !== history.length) {
    fail("history lists a version twice");
  }
  const versions = history.map((h, i): LegalVersion => {
    if (h.summary.trim() === "") fail(`version ${h.version} has no summary of changes`);
    if (isDraftVersion(h.version)) {
      if (i > 0) fail(`only the current version may be a draft, not ${h.version}`);
      const final = history[1];
      if (final !== undefined && !isDraftVersion(final.version)) {
        fail(
          `draft ${h.version} would hide final ${final.version}; give the new version its effective_date instead`,
        );
      }
      if (h.effective_date !== undefined) fail(`draft ${h.version} cannot have an effective date`);
      return { version: h.version, effectiveDate: null, summary: h.summary.trim() };
    }
    if (!isIsoDate(h.effective_date))
      fail(`version ${h.version} needs an effective_date, YYYY-MM-DD`);
    return {
      version: h.version,
      effectiveDate: h.effective_date ?? null,
      summary: h.summary.trim(),
    };
  });
  const current = versions[0];
  if (current && current.effectiveDate !== null) {
    if (frontmatterField(markdown, "effective_date") !== current.effectiveDate) {
      fail(`${entry.file} must state effective_date: ${current.effectiveDate}`);
    }
  }
  const dated = versions.flatMap((v) => (v.effectiveDate === null ? [] : [v.effectiveDate]));
  if (dated.some((day, i) => i > 0 && day > (dated[i - 1] ?? day))) {
    fail("history must list versions newest first");
  }
  return versions;
}

/**
 * The source of an app's generated legal text module: the body of each document the app serves,
 * frontmatter removed, so the server bundle carries the text and no page reads a file at runtime,
 * with each document's versions for the page to list. Internal documents never enter it.
 * LEGAL_SLUGS is every public document, served here or not.
 */
export function legalTextSource(
  stamp: string,
  documents: readonly LegalTextEntry[],
  read: (file: string) => string,
  serves: (slug: string) => boolean = () => true,
): string {
  const published = documents.filter((d) => d.publish === "public");
  const served = published.filter((d) => serves(d.slug)).map((d) => ({ d, source: read(d.file) }));
  const text = Object.fromEntries(
    served.map(({ d, source }) => [d.slug, stripFrontmatter(source)]),
  );
  const history = Object.fromEntries(
    served.map(({ d, source }) => [d.slug, legalVersions(d, source)]),
  );
  return `${stamp}
import type { LegalVersion } from "@xos/ui/legal-text";

/** The text of each legal document this app serves, without its frontmatter (Section 14.4). */
export const LEGAL_TEXT: Readonly<Record<string, string>> = ${JSON.stringify(text)};

/**
 * Each served document's versions, newest first, from legal/index.yaml: the first is the current
 * one, and its effective date is the one its frontmatter states (null while it is a draft).
 */
export const LEGAL_HISTORY: Readonly<Record<string, readonly LegalVersion[]>> = ${JSON.stringify(history)};

/** Every public legal document, whichever app serves it. */
export const LEGAL_SLUGS: readonly string[] = ${JSON.stringify(published.map((d) => d.slug))};
`;
}
