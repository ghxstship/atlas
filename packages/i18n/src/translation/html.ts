/**
 * The HTML that carries one segment to Google Cloud Translation (mimeType text/html) and back.
 * Everything that must survive unchanged travels inside `<span translate="no" id="...">`, and rich
 * text tags travel as `<span id="...">` around their translatable children. The reply is parsed back
 * with the small parser below; any element other than a span is refused.
 */

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const cp = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** A span whose content Google must leave alone. */
export function frozenSpan(id: string, content: string): string {
  return `<span translate="no" id="${id}">${escapeHtml(content)}</span>`;
}

export type HtmlNode =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "span"; readonly id: string | null; readonly children: HtmlNode[] };

export class MarkupError extends Error {
  override readonly name = "MarkupError";
}

/** Parses the spans of a translated segment. Throws MarkupError on any other element or bad nesting. */
export function parseSpans(html: string): HtmlNode[] {
  const root: HtmlNode[] = [];
  const stack: HtmlNode[][] = [root];
  const tag = /<\s*(\/)?\s*([a-zA-Z][\w-]*)([^>]*)>/g;
  let last = 0;
  const top = (): HtmlNode[] => stack[stack.length - 1] ?? root;
  const pushText = (raw: string) => {
    if (raw !== "") top().push({ kind: "text", text: decodeEntities(raw) });
  };
  for (let m = tag.exec(html); m !== null; m = tag.exec(html)) {
    pushText(html.slice(last, m.index));
    last = tag.lastIndex;
    const [, closing, name = "", attrs = ""] = m;
    if (name.toLowerCase() !== "span") throw new MarkupError(`unexpected <${name}> element`);
    if (closing) {
      if (stack.length === 1) throw new MarkupError("a closing </span> without an opening one");
      stack.pop();
      continue;
    }
    const id = /\bid\s*=\s*["']?([\w-]+)/i.exec(attrs)?.[1] ?? null;
    const children: HtmlNode[] = [];
    top().push({ kind: "span", id, children });
    if (!attrs.trimEnd().endsWith("/")) stack.push(children);
  }
  pushText(html.slice(last));
  if (stack.length !== 1) throw new MarkupError("an unclosed <span>");
  return root;
}

/** The visible text of a segment, without markup: what Google bills for, less the markup. */
export function textOf(html: string): string {
  return decodeEntities(stripTags(html));
}

/**
 * The HTML without its `<...>` tags, as `html.replace(/<[^>]*>/g, "")` returns it. One pass by position, so removing
 * one tag cannot leave the start of another to a second pattern, and an unclosed bracket costs nothing extra.
 */
export function stripTags(html: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = html.indexOf("<", from);
    if (open === -1) break;
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    out += html.slice(from, open);
    from = close + 1;
  }
  return out + html.slice(from);
}

const FROZEN_OPEN = '<span translate="no"';
const SPAN_CLOSE = "</span>";

/**
 * The HTML without its frozen spans (`<span translate="no" ...>...</span>` on one line), content included, as
 * `html.replace(/<span translate="no"[^>]*>.*?<\/span>/g, "")` returns it.
 */
export function stripFrozenSpans(html: string): string {
  let out = "";
  let kept = 0;
  let from = 0;
  for (;;) {
    const open = html.indexOf(FROZEN_OPEN, from);
    if (open === -1) break;
    const openEnd = html.indexOf(">", open + FROZEN_OPEN.length);
    if (openEnd === -1) break;
    const close = html.indexOf(SPAN_CLOSE, openEnd + 1);
    if (close === -1) break;
    if (/[\n\r\u2028\u2029]/.test(html.slice(openEnd + 1, close))) {
      from = open + 1;
      continue;
    }
    out += html.slice(kept, open);
    kept = close + SPAN_CLOSE.length;
    from = kept;
  }
  return out + html.slice(kept);
}
