/**
 * Copy for the docs site comes from the `docs` namespace in @xos/i18n (ADR 0021), plus the
 * shared `help` namespace for article kinds and What's New. Guide and article bodies are
 * per-locale Markdown files.
 */
import { getMessages, locales } from "@xos/i18n";

export const LOCALES = locales;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en-US";

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

type Vars = Readonly<Record<string, string | number>>;

function lookup(tree: unknown, key: string): string {
  let node: unknown = tree;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) break;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "string") throw new Error(`Missing message ${key}.`);
  return node;
}

function format(message: string, vars?: Vars): string {
  return vars
    ? message.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
    : message;
}

export type Translate = (key: string, vars?: Vars) => string;

/** A translator for one namespace of one locale. */
export function translator(locale: Locale, namespace: "docs" | "help" = "docs"): Translate {
  const messages = getMessages(locale) as unknown as Record<string, unknown>;
  const tree = messages[namespace];
  return (key, vars) => format(lookup(tree, key), vars);
}

/**
 * Flat `ui` messages for @xos/ui, which ships only en-US (A24-009); other locales pass theirs
 * through XOSProvider.
 */
export function uiMessages(locale: Locale): Record<string, string> | undefined {
  if (locale === DEFAULT_LOCALE) return undefined;
  const out: Record<string, string> = {};
  const walk = (value: unknown, prefix: string) => {
    if (typeof value === "string") out[prefix] = value;
    else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}.${k}` : k);
    }
  };
  walk(getMessages(locale).ui, "");
  return out;
}

/** Picks the best supported locale from an Accept-Language header. */
export function negotiate(header: string | null): Locale {
  const wanted = (header ?? "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      return { tag: (tag ?? "").toLowerCase(), q: q ? Number(q.trim().slice(2)) : 1 };
    })
    .filter((w) => w.tag !== "" && w.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of wanted) {
    const exact = LOCALES.find((l) => l.toLowerCase() === tag);
    if (exact) return exact;
    const language = LOCALES.find((l) => l.toLowerCase().split("-")[0] === tag.split("-")[0]);
    if (language) return language;
  }
  return DEFAULT_LOCALE;
}
