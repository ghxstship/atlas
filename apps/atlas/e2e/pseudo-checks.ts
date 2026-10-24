import type { Page } from "@playwright/test";
import pg from "pg";

/**
 * Gate 16 (Section 15): no hard-coded or truncated strings under the pseudo-locales.
 *
 * en-XA wraps every catalog message in `[` … ` ·]`, accents its letters and pads it by about 40
 * percent (i18n/pseudo.ts), so any text a person sees outside a wrap did not come from a catalog. It
 * is either data (a project name, a person, a formatted date) or a hard-coded or untranslated
 * string. Data is told apart by looking the text up in the database the page reads from, and by
 * the shapes Intl formatting produces; what is left is a finding.
 *
 * The truncation check finds text cut off by its box (overflow hidden or clip, or an ellipsis) that
 * offers no title or tooltip with the full text, the failure the 40 percent padding provokes.
 *
 * apps/gateway/e2e/pseudo-checks.ts keeps the same checks for Gateway.
 */

export interface Found {
  /** The text, trimmed and shortened. */
  readonly text: string;
  /** Where it is: a short element path, and the attribute when the text is one. */
  readonly where: string;
}

/** Visible text and labelling attributes that sit outside every en-XA wrap. */
export async function unwrappedText(page: Page): Promise<Found[]> {
  return page.evaluate(() => {
    const out: { text: string; where: string }[] = [];
    const inlineDisplays = new Set(["inline", "inline-block", "inline-flex", "inline-grid"]);
    const skip =
      "script, style, noscript, template, kbd, code, nextjs-portal, [data-pseudo-exempt]";
    const path = (el: Element) => {
      const parts: string[] = [];
      for (let n: Element | null = el; n && parts.length < 4; n = n.parentElement) {
        const id = n.id ? `#${n.id}` : "";
        const role = n.getAttribute("role");
        parts.unshift(`${n.tagName.toLowerCase()}${id}${role ? `[role=${role}]` : ""}`);
      }
      return parts.join(" > ");
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.opacity !== "0";
    };
    const blockOf = (el: Element): Element => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        if (!inlineDisplays.has(getComputedStyle(n).display)) return n;
      }
      return document.body;
    };
    /** Character ranges of `text` outside `[` … `]` pairs. */
    const outside = (text: string) => {
      const flags: boolean[] = [];
      let depth = 0;
      for (const char of text) {
        if (char === "[") depth += 1;
        flags.push(depth === 0);
        if (char === "]") depth = Math.max(0, depth - 1);
      }
      return flags;
    };
    const runsOf = (text: string, flags: boolean[], from: number) => {
      const runs: string[] = [];
      let run = "";
      const chars = [...text];
      for (let i = 0; i < chars.length; i += 1) {
        if (flags[from + i]) run += chars[i];
        else if (run) {
          runs.push(run);
          run = "";
        }
      }
      if (run) runs.push(run);
      return runs.map((r) => r.trim()).filter((r) => /[A-Za-z]{2,}/.test(r));
    };

    // Text nodes, read in the context of their block so a message split by inline markup (rich
    // text, a link inside a sentence) is still seen as one wrap.
    const byBlock = new Map<Element, Text[]>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      const parent = text.parentElement;
      if (!parent || !text.data.trim() || parent.closest(skip) || !visible(parent)) continue;
      const block = blockOf(parent);
      byBlock.set(block, [...(byBlock.get(block) ?? []), text]);
    }
    for (const [, texts] of byBlock) {
      const whole = texts.map((t) => t.data).join("");
      const flags = outside(whole);
      let offset = 0;
      for (const t of texts) {
        for (const run of runsOf(t.data, flags, offset)) {
          out.push({ text: run, where: path(t.parentElement as Element) });
        }
        offset += [...t.data].length;
      }
    }

    // Labels a person meets without seeing them on screen, and the shown option of a select.
    for (const el of document.body.querySelectorAll("*")) {
      if (el.closest(skip) || !visible(el)) continue;
      // The attributes that label an element, keyed so the names read as attributes.
      const labelling = { "aria-label": 1, placeholder: 1, title: 1, alt: 1 };
      for (const attribute of Object.keys(labelling)) {
        const value = el.getAttribute(attribute);
        if (!value?.trim()) continue;
        for (const run of runsOf(value, outside(value), 0)) {
          out.push({ text: run, where: `${path(el)} @${attribute}` });
        }
      }
      if (el instanceof HTMLSelectElement && el.selectedOptions[0]) {
        const value = el.selectedOptions[0].text;
        for (const run of runsOf(value, outside(value), 0)) {
          out.push({ text: run, where: `${path(el)} option` });
        }
      }
    }
    return out.map((f) => ({ text: f.text.slice(0, 120), where: f.where }));
  });
}

/**
 * Text cut off by a box that clips it (overflow hidden or clip, an ellipsis, a line clamp) with no
 * title or tooltip carrying the whole of it. Each visible text node's line boxes are measured
 * against every ancestor that clips them; a node partly outside such a box is cut off. A node
 * wholly outside one is hidden on purpose (a collapsed panel), not truncated.
 */
export async function truncatedText(page: Page): Promise<Found[]> {
  return page.evaluate(() => {
    const out: { text: string; where: string }[] = [];
    const path = (el: Element) => {
      const parts: string[] = [];
      for (let n: Element | null = el; n && parts.length < 4; n = n.parentElement) {
        const id = n.id ? `#${n.id}` : "";
        const role = n.getAttribute("role");
        parts.unshift(`${n.tagName.toLowerCase()}${id}${role ? `[role=${role}]` : ""}`);
      }
      return parts.join(" > ");
    };
    const clipsAxis = (value: string) => value === "hidden" || value === "clip";
    /** A title, or a tooltip trigger (Radix marks it with data-state), from the text to `upTo`. */
    const explained = (from: Element, upTo: Element) => {
      for (let n: Element | null = from; n; n = n.parentElement) {
        if (n.getAttribute("title")?.trim()) return true;
        if (n.hasAttribute("data-state") && n.hasAttribute("aria-describedby")) return true;
        if (n === upTo) return false;
      }
      return false;
    };
    /** Ancestors whose overflow clips this element, honoring fixed and absolute positioning. */
    const clippers = (el: Element): Element[] => {
      const found: Element[] = [];
      let needPositioned = false;
      for (
        let n: Element | null = el;
        n && n !== document.body.parentElement;
        n = n.parentElement
      ) {
        const s = getComputedStyle(n);
        if (!needPositioned || s.position !== "static") {
          needPositioned = false;
          if (clipsAxis(s.overflowX) || clipsAxis(s.overflowY)) found.push(n);
          // Text a scroll container holds is reached by scrolling, never cut off by the boxes
          // around that container (a page's own scroll region inside the app shell).
          if (/auto|scroll/.test(`${s.overflowX} ${s.overflowY}`)) break;
        }
        if (s.position === "fixed") break;
        if (s.position === "absolute") needPositioned = true;
      }
      return found;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      const parent = text.parentElement;
      if (!parent || !/\p{L}/u.test(text.data)) continue;
      if (parent.closest("script, style, noscript, template, nextjs-portal, svg")) continue;
      const ps = getComputedStyle(parent);
      if (ps.visibility === "hidden" || ps.opacity === "0") continue;
      range.selectNodeContents(text);
      const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (lines.length === 0) continue;
      for (const box of clippers(parent)) {
        const r = box.getBoundingClientRect();
        // Visually hidden labels (sr-only) clip on purpose and are read in full.
        if (r.width <= 2 || r.height <= 2) break;
        const s = getComputedStyle(box);
        const left = r.left + box.clientLeft;
        const top = r.top + box.clientTop;
        const clip = {
          left: clipsAxis(s.overflowX) ? left : -Infinity,
          right: clipsAxis(s.overflowX) ? left + box.clientWidth : Infinity,
          top: clipsAxis(s.overflowY) ? top : -Infinity,
          bottom: clipsAxis(s.overflowY) ? top + box.clientHeight : Infinity,
        };
        const inside = (l: DOMRect) =>
          l.left >= clip.left - 1 &&
          l.right <= clip.right + 1 &&
          l.top >= clip.top - 1 &&
          l.bottom <= clip.bottom + 1;
        const overlaps = (l: DOMRect) =>
          l.right > clip.left && l.left < clip.right && l.bottom > clip.top && l.top < clip.bottom;
        if (lines.every(inside)) continue;
        if (!lines.some(overlaps)) break;
        if (!explained(parent, box)) {
          const shown = text.data.trim().replace(/\s+/g, " ").slice(0, 120);
          const by = `${box.tagName.toLowerCase()}.${[...box.classList].slice(0, 4).join(".")}`;
          out.push({ text: shown, where: `${path(parent)} (clipped by ${by})` });
        }
        break;
      }
    }
    return out;
  });
}

/** Shapes en-US Intl formatting gives data: dates, times, relative times, numbers and money. */
const FORMATTED = [
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(, \d{4})?/,
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\b/,
  /^\d+ (second|minute|hour|day|week|month|year)s? ago$/,
  /^in \d+ (second|minute|hour|day|week|month|year)s?$/,
  /^(yesterday|today|tomorrow|now|last|next) ?(week|month|year)?$/,
  /^\d{1,2}:\d{2}( ?[AP]M)?$/,
  /^[AP]M$/,
  /^[A-Z]{3}$/,
  /^[\d\s.,:/$€£¥%+\-\u2013\u2014()·]*(AM|PM|USD|EUR|GBP|hrs?|min|h|d|K|M|B)?[\d\s.,:/$€£¥%+\-\u2013\u2014()·]*$/,
];

/** Never human text even when the database holds it: an event type or enum key shown raw. */
const RAW_KEY = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/;

/**
 * Every text value the demo database holds (text and character columns, and the strings inside
 * JSON columns), so text that is data is not mistaken for a hard-coded string. Loaded once per
 * worker; only ever from a local stack.
 */
let dataText: Promise<Set<string>> | undefined;

export function databaseText(): Promise<Set<string>> {
  dataText ??= (async () => {
    const url =
      process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
    if (!/@(127\.0\.0\.1|localhost):/.test(url)) {
      throw new Error("The pseudo-locale checks read only a local Supabase stack.");
    }
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const columns = await client.query<{ s: string; t: string; c: string; json: boolean }>(
        `select c.table_schema as s, c.table_name as t, c.column_name as c,
                c.data_type in ('json', 'jsonb') as json
           from information_schema.columns c
           join information_schema.tables t using (table_schema, table_name)
          where t.table_type = 'BASE TABLE'
            and c.table_schema in ('app', 'xpms', 'private', 'auth')
            and c.data_type in ('text', 'character varying', 'citext', 'json', 'jsonb')`,
      );
      const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
      const parts = columns.rows.map((col) =>
        col.json
          ? `select jsonb_path_query(${q(col.c)}::jsonb, 'strict $.**') #>> '{}' as v from ${q(col.s)}.${q(col.t)} where ${q(col.c)} is not null`
          : `select ${q(col.c)}::text as v from ${q(col.s)}.${q(col.t)} where ${q(col.c)} is not null`,
      );
      const values = new Set<string>();
      for (let i = 0; i < parts.length; i += 100) {
        const sql = `select distinct v from (${parts.slice(i, i + 100).join(" union all ")}) x where v is not null and length(v) < 400`;
        const result = await client.query<{ v: string }>(sql);
        for (const row of result.rows) values.add(row.v.trim());
      }
      return values;
    } finally {
      await client.end();
    }
  })();
  return dataText;
}

/** Separators code puts between data values ("NWS · Northwind Summer Series", "Lee, Jordan"). */
const SEPARATORS = /\s*(?:·|•|\u2014|\u2013|\||\/|,|:|›|>|\(|\)|\+)\s*|\s+-\s+/;

/** A record key (NWS-12) or a code (US-FL-MIAMI-DADE, G2.CONTRACTS), with any hyphen glyph. */
const CODE = /^[A-Z0-9]+(?:[-‐‑‒\u2013−_.][A-Z0-9]+)*$/;

function isData(raw: string, data: Set<string>): boolean {
  // Punctuation code puts between values ("· NWS") belongs to neither side.
  const text = raw.replace(/^[\s·•.,:;|/()\u2013\u2014-]+|[\s·•.,:;|/()\u2013\u2014-]+$/g, "");
  if (!/[A-Za-z]{2,}/.test(text)) return true;
  if (RAW_KEY.test(text)) return false;
  if (data.has(raw.trim()) || data.has(text)) return true;
  if (CODE.test(text)) return true;
  if (FORMATTED.some((re) => re.test(text))) return true;
  // Emails, web addresses, paths and initials.
  if (/^\S+@\S+\.\S+$/.test(text) || /^(https?:\/\/|\/)\S*$/.test(text)) return true;
  if (/^[A-Z]{1,3}$/.test(text)) return true;
  const pieces = text.split(SEPARATORS).filter((p) => /[A-Za-z]{2,}/.test(p));
  return (
    pieces.length > 1 &&
    pieces.every(
      (p) =>
        data.has(p) || FORMATTED.some((re) => re.test(p)) || /^[A-Z]{1,3}$/.test(p) || CODE.test(p),
    )
  );
}

/** Unwrapped text that is neither data nor formatting: hard-coded or untranslated strings. */
export async function hardCodedText(page: Page): Promise<Found[]> {
  const [found, data] = await Promise.all([unwrappedText(page), databaseText()]);
  const seen = new Set<string>();
  return found.filter((f) => {
    if (isData(f.text, data)) return false;
    const key = `${f.text}|${f.where}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One line per problem, for an assertion message that lists them all. */
export function describe(found: readonly Found[]): string[] {
  return found.map((f) => `"${f.text}" at ${f.where}`);
}
