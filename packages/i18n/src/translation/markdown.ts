/**
 * Markdown articles and plain text files through machine translation.
 *
 * Each line of prose is one segment: a heading, a list item, a table cell, a paragraph line or a
 * translatable front matter value (`title`, `summary`). Fenced code, table separators, raw HTML and
 * every other front matter line are copied unchanged. Inside a segment, code spans, URLs, images,
 * escapes and protected words are frozen spans; links, bold and italic are spans whose text is
 * translated and whose markup (and link target) is restored afterwards.
 */
import { MarkupError, escapeHtml, frozenSpan, parseSpans, type HtmlNode } from "./html.ts";
import { PlanError, tidy, type Plan, type ProtectFn, type Segment } from "./icu.ts";

type Mask =
  | { readonly kind: "raw"; readonly text: string }
  | { readonly kind: "wrap"; readonly open: string; readonly close: string };

interface Unit {
  readonly segment: number;
  readonly masks: ReadonlyMap<string, Mask>;
}

type Line =
  | string
  | {
      readonly prefix: string;
      readonly unit: Unit;
      readonly suffix: string;
      /** Set for a front matter value; `quoted` records whether the source value was quoted. */
      readonly yaml?: { readonly quoted: boolean };
    }
  | { readonly cells: readonly Unit[]; readonly indent: string };

const LETTER = /\p{L}/u;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

class Builder {
  readonly segments: Segment[] = [];
  private counter = 0;
  private readonly protect: ProtectFn;

  constructor(protect: ProtectFn) {
    this.protect = protect;
  }

  unit(text: string, markdown: boolean): Unit {
    const masks = new Map<string, Mask>();
    const html = markdown ? this.inline(text, masks) : this.plain(text, masks);
    const segment = this.segments.length;
    this.segments.push({ html, translatable: LETTER.test(this.visible(html)) });
    return { segment, masks };
  }

  private visible(html: string): string {
    return html.replace(/<span translate="no"[^>]*>.*?<\/span>/g, "").replace(/<[^>]*>/g, "");
  }

  private id(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }

  private frozen(text: string, masks: Map<string, Mask>): string {
    const id = this.id("m");
    masks.set(id, { kind: "raw", text });
    return frozenSpan(id, text);
  }

  /** Plain text: only protected words are frozen. */
  plain(text: string, masks: Map<string, Mask>): string {
    let out = "";
    let pos = 0;
    for (const r of this.protect(text)) {
      out += escapeHtml(text.slice(pos, r.start)) + this.frozen(text.slice(r.start, r.end), masks);
      pos = r.end;
    }
    return out + escapeHtml(text.slice(pos));
  }

  private wrap(open: string, close: string, inner: string, masks: Map<string, Mask>): string {
    const id = this.id("w");
    masks.set(id, { kind: "wrap", open, close });
    return `<span id="${id}">${this.inline(inner, masks)}</span>`;
  }

  /** Markdown inline syntax. */
  inline(text: string, masks: Map<string, Mask>): string {
    let out = "";
    let plain = "";
    const flush = () => {
      out += this.plain(plain, masks);
      plain = "";
    };
    let i = 0;
    while (i < text.length) {
      const rest = text.slice(i);
      const prev = i > 0 ? (text[i - 1] ?? "") : "";
      let m: RegExpExecArray | null;
      if (
        (m = /^\\[\\`*_{}[\]()#+\-.!|<>~]/.exec(rest)) ||
        (m = /^(`+)[\s\S]*?[^`]\1(?!`)/.exec(rest)) ||
        (m = /^!\[[^\]]*\]\([^)]*\)/.exec(rest)) ||
        (m = /^<(?:https?:\/\/[^>\s]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/.exec(rest)) ||
        (m = /^<\/?[a-zA-Z][^>]*>/.exec(rest))
      ) {
        flush();
        out += this.frozen(m[0], masks);
        i += m[0].length;
      } else if ((m = /^\[((?:[^[\]]|\[[^\]]*\])+)\]\(([^)]*)\)/.exec(rest))) {
        flush();
        out += this.wrap("[", `](${m[2] ?? ""})`, m[1] ?? "", masks);
        i += m[0].length;
      } else if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) {
        flush();
        out += this.wrap(m[1] ?? "", m[1] ?? "", m[2] ?? "", masks);
        i += m[0].length;
      } else if (
        !/[\p{L}\p{N}]/u.test(prev) &&
        (m = /^([*_])(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}])/u.exec(rest))
      ) {
        flush();
        out += this.wrap(m[1] ?? "", m[1] ?? "", m[2] ?? "", masks);
        i += m[0].length;
      } else {
        plain += text[i] ?? "";
        i += 1;
      }
    }
    flush();
    return out;
  }
}

/** Splits a table row into cells, honoring escaped pipes and pipes inside code spans. */
function cells(row: string): string[] {
  const body = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let cell = "";
  let ticks = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? "";
    if (ch === "\\" && i + 1 < body.length) {
      cell += ch + (body[i + 1] ?? "");
      i += 1;
    } else if (ch === "`") {
      ticks = ticks === 0 ? 1 : 0;
      cell += ch;
    } else if (ch === "|" && ticks === 0) {
      out.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  out.push(cell.trim());
  return out;
}

function unquoteYaml(value: string): { text: string; quoted: boolean } {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2)
    return { text: JSON.parse(v) as string, quoted: true };
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    return { text: v.slice(1, -1).replace(/''/g, "'"), quoted: true };
  return { text: v, quoted: false };
}

/** A YAML scalar for a front matter value: plain when safe, otherwise a JSON (double-quoted) string. */
export function yamlScalar(text: string, wasQuoted: boolean): string {
  const unsafe =
    wasQuoted || /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) || /:\s|\s#|:$|\s$/.test(text);
  return unsafe ? JSON.stringify(text) : text;
}

function renderUnit(builder: Builder, unit: Unit, outputs: readonly string[]): string {
  const segment = builder.segments[unit.segment];
  const translated = segment?.translatable ? outputs[unit.segment] : undefined;
  let nodes: HtmlNode[];
  try {
    nodes = parseSpans(translated ?? segment?.html ?? "");
  } catch (error) {
    if (error instanceof MarkupError) throw new PlanError(error.message);
    throw error;
  }
  const seen = new Set<string>();
  const walk = (list: readonly HtmlNode[]): string =>
    list
      .map((node) => {
        if (node.kind === "text") return translated === undefined ? node.text : tidy(node.text);
        const mask = node.id === null ? undefined : unit.masks.get(node.id);
        if (!mask || node.id === null)
          throw new PlanError(`unknown span ${node.id ?? "without id"}`);
        if (seen.has(node.id)) throw new PlanError(`span ${node.id} appears twice`);
        seen.add(node.id);
        return mask.kind === "raw" ? mask.text : `${mask.open}${walk(node.children)}${mask.close}`;
      })
      .join("");
  const text = walk(nodes);
  const missing = [...unit.masks.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) throw new PlanError(`spans ${missing.join(", ")} are missing`);
  return translated === undefined ? text : text.trim();
}

function finish(builder: Builder, lines: readonly Line[]): Plan {
  return {
    segments: builder.segments,
    assemble(outputs) {
      return lines
        .map((line) => {
          if (typeof line === "string") return line;
          if ("cells" in line)
            return `${line.indent}| ${line.cells.map((c) => renderUnit(builder, c, outputs)).join(" | ")} |`;
          const text = renderUnit(builder, line.unit, outputs);
          return `${line.prefix}${line.yaml ? yamlScalar(text, line.yaml.quoted) : text}${line.suffix}`;
        })
        .join("\n");
    },
  };
}

export interface MarkdownOptions {
  /** Front matter keys whose values are translated. */
  readonly frontMatter: readonly string[];
}

/** Plans the translation of a Markdown document with optional YAML front matter. */
export function planMarkdown(text: string, protect: ProtectFn, options: MarkdownOptions): Plan {
  const builder = new Builder(protect);
  const source = text.split("\n");
  const lines: Line[] = [];
  let i = 0;
  if (source[0] === "---") {
    const end = source.indexOf("---", 1);
    if (end > 0) {
      lines.push("---");
      for (i = 1; i < end; i++) {
        const raw = source[i] ?? "";
        const m = /^(\s*)([A-Za-z_][\w-]*):(\s*)(.*)$/.exec(raw);
        const value = m?.[4] ?? "";
        if (
          m &&
          options.frontMatter.includes(m[2] ?? "") &&
          value.trim() !== "" &&
          !/^[[{|>]/.test(value.trim())
        ) {
          const { text: inner, quoted } = unquoteYaml(value);
          lines.push({
            prefix: `${m[1] ?? ""}${m[2] ?? ""}:${m[3] || " "}`,
            unit: builder.unit(inner, false),
            suffix: "",
            yaml: { quoted },
          });
        } else lines.push(raw);
      }
      lines.push("---");
      i = end + 1;
    }
  }
  let fence: string | null = null;
  for (; i < source.length; i++) {
    const raw = source[i] ?? "";
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence !== null) {
      lines.push(raw);
      if (
        fenceMatch &&
        fenceMatch[1]?.[0] === fence[0] &&
        (fenceMatch[1]?.length ?? 0) >= fence.length
      )
        fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] ?? "```";
      lines.push(raw);
      continue;
    }
    if (raw.trim() === "" || /^\s*</.test(raw) || TABLE_SEPARATOR.test(raw) || !LETTER.test(raw)) {
      lines.push(raw);
      continue;
    }
    if (/^\s*\|/.test(raw)) {
      lines.push({
        indent: /^\s*/.exec(raw)?.[0] ?? "",
        cells: cells(raw).map((c) => builder.unit(c, true)),
      });
      continue;
    }
    const m = /^(\s*(?:#{1,6}\s+|>\s?|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)*)(.*?)(\s*)$/.exec(
      raw,
    );
    lines.push({
      prefix: m?.[1] ?? "",
      unit: builder.unit(m?.[2] ?? raw, true),
      suffix: m?.[3] ?? "",
    });
  }
  return finish(builder, lines);
}

/** Plans the translation of a plain text file: one segment per non-empty line, protected words frozen. */
export function planText(text: string, protect: ProtectFn): Plan {
  const builder = new Builder(protect);
  const lines: Line[] = text.split("\n").map((raw) => {
    if (!LETTER.test(raw)) return raw;
    const m = /^(\s*)(.*?)(\s*)$/.exec(raw);
    return { prefix: m?.[1] ?? "", unit: builder.unit(m?.[2] ?? raw, false), suffix: m?.[3] ?? "" };
  });
  return finish(builder, lines);
}
