/**
 * ICU MessageFormat messages through machine translation.
 *
 * A message becomes one or more segments of HTML. Each run of text at one level of the message is
 * one segment: simple arguments (`{name}`, `{n, number}`, `{d, date, short}`), `#` and protected
 * words are frozen spans, and rich text tags (`<b>...</b>`) are spans whose children are translated
 * in place, so the words around them keep their context. A plural, select or selectordinal is a
 * frozen span in its parent's segment, and every one of its branches is a segment of its own. After
 * translation the message is put back together from the original syntax (argument headers, branch
 * keys and spacing are copied from the en-US source), and only the literal text is new.
 */
import {
  TYPE,
  parse,
  type MessageFormatElement,
  type PluralElement,
  type SelectElement,
} from "@formatjs/icu-messageformat-parser";
import { doPrintAST } from "@formatjs/icu-messageformat-parser/printer.js";
import { MarkupError, escapeHtml, frozenSpan, parseSpans, type HtmlNode } from "./html.ts";
import type { Range } from "./protect.ts";

export interface Segment {
  readonly html: string;
  /** False when the segment has no words to translate (only arguments, numbers or punctuation). */
  readonly translatable: boolean;
}

export interface Plan {
  readonly segments: readonly Segment[];
  /** Rebuilds the target from one translated HTML string per segment. Throws PlanError when broken. */
  assemble(outputs: readonly string[]): string;
}

export class PlanError extends Error {
  override readonly name = "PlanError";
}

type Mask =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "syntax"; readonly text: string }
  | { readonly kind: "pound" }
  | { readonly kind: "tag"; readonly name: string }
  | {
      readonly kind: "complex";
      readonly element: PluralElement | SelectElement;
      readonly options: ReadonlyArray<{ readonly key: string; readonly level: Level }>;
    };

interface Level {
  readonly segment: number;
  readonly masks: ReadonlyMap<string, Mask>;
  readonly inPlural: boolean;
  readonly leading: string;
  readonly trailing: string;
}

type Piece = { readonly literal: string } | { readonly syntax: string };

export type ProtectFn = (text: string) => Range[];

const LETTER = /\p{L}/u;

function offsets(el: { location?: { start: { offset: number }; end: { offset: number } } }) {
  if (!el.location) throw new PlanError("the parser returned no location");
  return { start: el.location.start.offset, end: el.location.end.offset };
}

/** Plans the translation of one ICU message. Throws when the message is not valid ICU. */
export function planIcu(message: string, protect: ProtectFn): Plan {
  const ast = parse(message, { captureLocation: true });
  const segments: Segment[] = [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}${++counter}`;
  const slice = (el: Parameters<typeof offsets>[0]) => {
    const { start, end } = offsets(el);
    return message.slice(start, end);
  };

  function buildLevel(elements: readonly MessageFormatElement[], inPlural: boolean): Level {
    const masks = new Map<string, Mask>();
    let html = "";
    let translatable = false;
    const emit = (els: readonly MessageFormatElement[]) => {
      for (const el of els) {
        switch (el.type) {
          case TYPE.literal: {
            let pos = 0;
            for (const r of protect(el.value)) {
              const before = el.value.slice(pos, r.start);
              if (LETTER.test(before)) translatable = true;
              html += escapeHtml(before);
              const id = nextId("d");
              const text = el.value.slice(r.start, r.end);
              masks.set(id, { kind: "literal", text });
              html += frozenSpan(id, text);
              pos = r.end;
            }
            const rest = el.value.slice(pos);
            if (LETTER.test(rest)) translatable = true;
            html += escapeHtml(rest);
            break;
          }
          case TYPE.argument:
          case TYPE.number:
          case TYPE.date:
          case TYPE.time: {
            const id = nextId("a");
            masks.set(id, { kind: "syntax", text: slice(el) });
            html += frozenSpan(id, slice(el));
            break;
          }
          case TYPE.pound: {
            const id = nextId("p");
            masks.set(id, { kind: "pound" });
            html += frozenSpan(id, "#");
            break;
          }
          case TYPE.tag: {
            const id = nextId("t");
            masks.set(id, { kind: "tag", name: el.value });
            html += `<span id="${id}">`;
            emit(el.children);
            html += "</span>";
            break;
          }
          case TYPE.select:
          case TYPE.plural: {
            const id = nextId("c");
            const branchInPlural = el.type === TYPE.plural;
            const options = Object.entries(el.options)
              .sort(([, a], [, b]) => offsets(a).start - offsets(b).start)
              .map(([key, option]) => ({ key, level: buildLevel(option.value, branchInPlural) }));
            masks.set(id, { kind: "complex", element: el, options });
            html += frozenSpan(id, `{${el.value}}`);
            break;
          }
        }
      }
    };
    emit(elements);
    const first = elements[0];
    const last = elements[elements.length - 1];
    const leading = first?.type === TYPE.literal ? (/^\s*/.exec(first.value)?.[0] ?? "") : "";
    const trailing = last?.type === TYPE.literal ? (/\s*$/.exec(last.value)?.[0] ?? "") : "";
    const segment = segments.length;
    segments.push({ html, translatable });
    return { segment, masks, inPlural, leading, trailing };
  }

  const top = buildLevel(ast, false);

  function assembleComplex(
    el: PluralElement | SelectElement,
    bodies: ReadonlyArray<{ readonly key: string; readonly body: string }>,
  ): string {
    const options = Object.values(el.options).sort((a, b) => offsets(a).start - offsets(b).start);
    const whole = offsets(el);
    let out = "";
    let cursor = whole.start;
    options.forEach((option, i) => {
      const o = offsets(option);
      out += message.slice(cursor, o.start);
      out += `{${bodies[i]?.body ?? ""}}`;
      cursor = o.end;
    });
    return out + message.slice(cursor, whole.end);
  }

  function renderLevel(level: Level, outputs: readonly string[]): string {
    const original = segments[level.segment]?.html ?? "";
    const translated = segments[level.segment]?.translatable ? outputs[level.segment] : undefined;
    let nodes: HtmlNode[];
    try {
      nodes = parseSpans(translated ?? original);
    } catch (error) {
      if (error instanceof MarkupError) throw new PlanError(error.message);
      throw error;
    }
    const seen = new Set<string>();
    const pieces: Piece[] = [];
    const walk = (list: readonly HtmlNode[]) => {
      for (const node of list) {
        if (node.kind === "text") {
          pieces.push({ literal: translated === undefined ? node.text : tidy(node.text) });
          continue;
        }
        const mask = node.id === null ? undefined : level.masks.get(node.id);
        if (!mask || node.id === null)
          throw new PlanError(`unknown span ${node.id ?? "without id"}`);
        if (seen.has(node.id)) throw new PlanError(`span ${node.id} appears twice`);
        seen.add(node.id);
        switch (mask.kind) {
          case "literal":
            pieces.push({ literal: mask.text });
            break;
          case "syntax":
            pieces.push({ syntax: mask.text });
            break;
          case "pound":
            pieces.push({ syntax: "#" });
            break;
          case "tag":
            pieces.push({ syntax: `<${mask.name}>` });
            walk(node.children);
            pieces.push({ syntax: `</${mask.name}>` });
            break;
          case "complex":
            pieces.push({
              syntax: assembleComplex(
                mask.element,
                mask.options.map((o) => ({ key: o.key, body: renderLevel(o.level, outputs) })),
              ),
            });
            break;
        }
      }
    };
    walk(nodes);
    const missing = [...level.masks.keys()].filter((id) => !seen.has(id));
    if (missing.length > 0) throw new PlanError(`spans ${missing.join(", ")} are missing`);
    const body = joinPieces(pieces, level.inPlural);
    return translated === undefined ? body : `${level.leading}${body.trim()}${level.trailing}`;
  }

  return {
    segments,
    assemble(outputs) {
      let out = renderLevel(top, outputs);
      if (/^\p{Lu}/u.test(message) && /^\p{Ll}/u.test(out))
        out = out[0]?.toUpperCase() + out.slice(1);
      return out;
    },
  };
}

/** Joins literal and syntax pieces, escaping literal text the way the formatjs printer does. */
function joinPieces(pieces: readonly Piece[], inPlural: boolean): string {
  const merged: Piece[] = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    if ("literal" in p && prev && "literal" in prev)
      merged[merged.length - 1] = { literal: prev.literal + p.literal };
    else merged.push(p);
  }
  return merged
    .map((p, i) => {
      if ("syntax" in p) return p.syntax;
      let value = p.literal;
      // An apostrophe right before an argument or tag would open an ICU quote, so it is doubled.
      if (i < merged.length - 1 && value.endsWith("'")) value = `${value.slice(0, -1)}''`;
      return doPrintAST([{ type: TYPE.literal, value }], inPlural);
    })
    .join("");
}

/**
 * Cleans one translated text run: no em dash (the finish guard refuses it; ADR 0033 decision 26
 * accepts the substitution), no non-breaking or doubled spaces, and no space that Google left between
 * a frozen span and the punctuation next to it (at the start or end of the run).
 */
export function tidy(text: string): string {
  let out = text.replace(/\u00a0/g, " ");
  if (out.includes("\u2014"))
    out = out.replace(/\s*\u2014\s*/g, ", ").replace(/, (?=[,.;:!?])/g, "");
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^\s+(?=[,.;:!?)\]](?:\s|$))/, "")
    .replace(/([¿¡([])\s+$/, "$1");
}

/** The literal text of a message, without any ICU syntax: what terminology rules read. */
export function literalText(message: string): string {
  const out: string[] = [];
  const walk = (els: readonly MessageFormatElement[]) => {
    for (const el of els) {
      if (el.type === TYPE.literal) out.push(el.value);
      else if (el.type === TYPE.tag) walk(el.children);
      else if (el.type === TYPE.plural || el.type === TYPE.select) {
        for (const option of Object.values(el.options)) {
          out.push(" ");
          walk(option.value);
        }
      } else out.push(" ");
    }
  };
  walk(parse(message));
  return out.join("").replace(/\s+/g, " ").trim();
}

interface Shape {
  readonly args: Map<string, string>;
  readonly selects: Map<string, string>;
  readonly plurals: Map<
    string,
    { kind: string; offset: number; exact: string; categories: string[] }
  >;
  readonly tags: string[];
}

function shapeOf(message: string): Shape {
  const shape: Shape = { args: new Map(), selects: new Map(), plurals: new Map(), tags: [] };
  const walk = (els: readonly MessageFormatElement[]) => {
    for (const el of els) {
      switch (el.type) {
        case TYPE.argument:
          shape.args.set(el.value, "argument");
          break;
        case TYPE.number:
        case TYPE.date:
        case TYPE.time: {
          const style =
            typeof el.style === "string" ? el.style : el.style ? JSON.stringify(el.style) : "";
          shape.args.set(el.value, `${TYPE[el.type]}:${style}`);
          break;
        }
        case TYPE.tag:
          shape.tags.push(el.value);
          walk(el.children);
          break;
        case TYPE.select:
          shape.selects.set(el.value, Object.keys(el.options).sort().join("|"));
          for (const option of Object.values(el.options)) walk(option.value);
          break;
        case TYPE.plural: {
          const keys = Object.keys(el.options);
          shape.plurals.set(el.value, {
            kind: el.pluralType === "ordinal" ? "selectordinal" : "plural",
            offset: el.offset,
            exact: keys
              .filter((k) => k.startsWith("="))
              .sort()
              .join("|"),
            categories: keys.filter((k) => !k.startsWith("=")).sort(),
          });
          for (const option of Object.values(el.options)) walk(option.value);
          break;
        }
        default:
          break;
      }
    }
  };
  walk(parse(message));
  shape.tags.sort();
  return shape;
}

const pluralCategories = new Map<string, Set<string>>();
function categoriesFor(locale: string, kind: string): Set<string> {
  const key = `${locale}:${kind}`;
  let set = pluralCategories.get(key);
  if (!set) {
    const type = kind === "selectordinal" ? "ordinal" : "cardinal";
    set = new Set(new Intl.PluralRules(locale, { type }).resolvedOptions().pluralCategories);
    pluralCategories.set(key, set);
  }
  return set;
}

/**
 * Differences between the ICU structure of a source and a target message, empty when they match:
 * the same arguments with the same types and styles, the same select keys, the same plural exact
 * keys and offset, plural categories that the source or the target locale uses (always with
 * `other`), and the same rich text tags. Throws when either message is not valid ICU.
 */
export function compareStructure(source: string, target: string, targetLocale: string): string[] {
  const a = shapeOf(source);
  const b = shapeOf(target);
  const problems: string[] = [];
  const names = new Set([...a.args.keys(), ...b.args.keys()]);
  for (const name of names) {
    if (!a.args.has(name)) problems.push(`{${name}} is not in the source`);
    else if (!b.args.has(name)) problems.push(`{${name}} is missing`);
    else if (a.args.get(name) !== b.args.get(name))
      problems.push(`{${name}} changed type or style`);
  }
  for (const [name, keys] of a.selects) {
    if (!b.selects.has(name)) problems.push(`select {${name}} is missing`);
    else if (b.selects.get(name) !== keys) problems.push(`select {${name}} has different keys`);
  }
  for (const name of b.selects.keys())
    if (!a.selects.has(name)) problems.push(`select {${name}} is not in the source`);
  for (const [name, p] of a.plurals) {
    const q = b.plurals.get(name);
    if (!q) {
      problems.push(`${p.kind} {${name}} is missing`);
      continue;
    }
    if (q.kind !== p.kind || q.offset !== p.offset || q.exact !== p.exact)
      problems.push(`${p.kind} {${name}} changed its kind, offset or exact keys`);
    const allowed = categoriesFor(targetLocale, p.kind);
    const extra = q.categories.filter((c) => !p.categories.includes(c) && !allowed.has(c));
    if (extra.length > 0)
      problems.push(
        `${p.kind} {${name}} has categories ${extra.join(", ")} that ${targetLocale} does not use`,
      );
    if (!q.categories.includes("other")) problems.push(`${p.kind} {${name}} has no other branch`);
  }
  for (const name of b.plurals.keys())
    if (!a.plurals.has(name)) problems.push(`plural {${name}} is not in the source`);
  if (a.tags.join() !== b.tags.join())
    problems.push(`tags differ: <${a.tags.join("> <")}> and <${b.tags.join("> <")}>`);
  return problems;
}
