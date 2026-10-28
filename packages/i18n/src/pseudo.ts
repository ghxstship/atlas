/**
 * Pseudo-locales for development (Section 15): en-XA accents every letter and pads each message by
 * about 40 percent; ar-XB mirrors the layout right to left. Both are derived at runtime from the
 * en-US catalog, so every namespace (shell, nav, ui) is covered and nothing is stored twice.
 * ICU syntax survives: argument names, plural and select keywords, `#` and rich text tags stay as
 * they are, and only the literal text, including plural and select bodies, is transformed.
 *
 * One home for every web shell: Atlas, Gateway, the operator console and the docs site negotiate
 * them outside production only.
 */

export const PSEUDO_LOCALES = ["en-XA", "ar-XB"] as const;
export type PseudoLocale = (typeof PSEUDO_LOCALES)[number];

export function isPseudoLocale(value: string): value is PseudoLocale {
  return (PSEUDO_LOCALES as readonly string[]).includes(value);
}

const ACCENTS: Record<string, string> = {
  a: "à",
  b: "ƀ",
  c: "ç",
  d: "ð",
  e: "é",
  f: "ƒ",
  g: "ĝ",
  h: "ĥ",
  i: "î",
  j: "ĵ",
  k: "ķ",
  l: "ļ",
  m: "ɱ",
  n: "ñ",
  o: "ö",
  p: "þ",
  q: "ǫ",
  r: "ŕ",
  s: "š",
  t: "ţ",
  u: "û",
  v: "ṽ",
  w: "ŵ",
  x: "ẋ",
  y: "ý",
  z: "ž",
  A: "À",
  B: "Ɓ",
  C: "Ç",
  D: "Ð",
  E: "É",
  F: "Ƒ",
  G: "Ĝ",
  H: "Ĥ",
  I: "Î",
  J: "Ĵ",
  K: "Ķ",
  L: "Ļ",
  M: "Ṁ",
  N: "Ñ",
  O: "Ö",
  P: "Þ",
  Q: "Ǫ",
  R: "Ŕ",
  S: "Š",
  T: "Ţ",
  U: "Û",
  V: "Ṽ",
  W: "Ŵ",
  X: "Ẋ",
  Y: "Ý",
  Z: "Ž",
};

/** Right-to-left override and pop directional formatting, wrapped around each ar-XB message. */
const RLO = "‮";
const PDF = "‬";

type TextTransform = (text: string) => string;

/** Index of the brace that closes the one at `open`, honoring nesting. */
function closingBrace(message: string, open: number): number {
  let depth = 0;
  for (let i = open; i < message.length; i++) {
    const char = message[i];
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return message.length - 1;
}

/** Transforms the option bodies of `key {body} key {body}` in a plural or select argument. */
function transformOptions(options: string, transform: TextTransform): string {
  let out = "";
  let i = 0;
  while (i < options.length) {
    const open = options.indexOf("{", i);
    if (open < 0) return out + options.slice(i);
    const close = closingBrace(options, open);
    out += options.slice(i, open + 1);
    out += transformMessage(options.slice(open + 1, close), transform);
    out += "}";
    i = close + 1;
  }
  return out;
}

function transformArgument(argument: string, transform: TextTransform): string {
  const match = /^(\s*[A-Za-z0-9_]+\s*,\s*(plural|select|selectordinal)\s*,)([\s\S]*)$/.exec(
    argument,
  );
  if (!match) return argument;
  return `${match[1]}${transformOptions(match[3] ?? "", transform)}`;
}

/** Transforms literal text in an ICU message, leaving arguments, `#` and tags intact. */
export function transformMessage(message: string, transform: TextTransform): string {
  let out = "";
  let text = "";
  const flush = () => {
    out += transform(text);
    text = "";
  };
  let i = 0;
  while (i < message.length) {
    const char = message[i] as string;
    if (char === "{") {
      flush();
      const close = closingBrace(message, i);
      out += `{${transformArgument(message.slice(i + 1, close), transform)}}`;
      i = close + 1;
      continue;
    }
    const tag = char === "<" ? /^<\/?[A-Za-z][\w-]*>/.exec(message.slice(i)) : null;
    if (tag) {
      flush();
      out += tag[0];
      i += tag[0].length;
      continue;
    }
    if (char === "#" || char === "'") {
      flush();
      out += char;
      i++;
      continue;
    }
    text += char;
    i++;
  }
  flush();
  return out;
}

const accent: TextTransform = (text) => text.replace(/[A-Za-z]/g, (c) => ACCENTS[c] ?? c);

function pad(message: string): string {
  const letters = message.replace(/\{[^}]*\}/g, "").length;
  const extra = Math.max(1, Math.ceil(letters * 0.4));
  return `[${message} ${"·".repeat(extra)}]`;
}

/** One message in a pseudo-locale. */
export function pseudoMessage(message: string, locale: PseudoLocale): string {
  if (locale === "en-XA") return pad(transformMessage(message, accent));
  return `${RLO}${transformMessage(message, accent)}${PDF}`;
}

type Catalog = { readonly [key: string]: string | Catalog };

/** A whole catalog in a pseudo-locale, keeping its key structure. */
export function pseudoCatalog<T extends Catalog>(catalog: T, locale: PseudoLocale): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(catalog)) {
    out[key] =
      typeof value === "string" ? pseudoMessage(value, locale) : pseudoCatalog(value, locale);
  }
  return out as T;
}
