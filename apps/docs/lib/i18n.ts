/**
 * Copy for the docs site comes from the `docs` namespace in @xos/i18n (ADR 0021), plus the
 * shared `help` namespace for article kinds and What's New. Guide and article bodies are
 * per-locale Markdown files.
 */
import { getMessages, launchLocales, type LaunchLocale, type Messages } from "@xos/i18n";
import { PSEUDO_LOCALES, isPseudoLocale, pseudoCatalog, type PseudoLocale } from "@xos/i18n/pseudo";

/** The docs site and help center publish the launch locales; Beta locales (ADR 0053) cover app copy only. */
export const PUBLISHED_LOCALES = launchLocales;

/**
 * The locale prefixes the site serves: the published locales, plus the pseudo-locales (Section 15)
 * outside production, so every page can be checked for hard-coded and clipped strings on `next dev`.
 * A production build prerenders and serves the published locales only.
 */
export const LOCALES: readonly Locale[] =
  process.env.NODE_ENV === "production" ? launchLocales : [...launchLocales, ...PSEUDO_LOCALES];
export type Locale = LaunchLocale | PseudoLocale;
export const DEFAULT_LOCALE: Locale = "en-US";

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** The locale whose Markdown a page reads: a pseudo-locale reads en-US, its source. */
export function contentLocale(locale: Locale): LaunchLocale {
  return isPseudoLocale(locale) ? "en-US" : locale;
}

/** Writing direction of a locale (ar-XB is the right-to-left pseudo-locale). */
export function localeDirection(locale: Locale): "ltr" | "rtl" {
  return locale === "ar-XB" ? "rtl" : "ltr";
}

const pseudoMessages = new Map<PseudoLocale, Messages>();

/** A locale's catalog: a shipped one, or one derived from en-US for a pseudo-locale. */
function messagesFor(locale: Locale): Messages {
  if (!isPseudoLocale(locale)) return getMessages(locale);
  let messages = pseudoMessages.get(locale);
  if (messages === undefined) {
    messages = pseudoCatalog(getMessages("en-US"), locale);
    pseudoMessages.set(locale, messages);
  }
  return messages;
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
  const messages = messagesFor(locale) as unknown as Record<string, unknown>;
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
  walk(messagesFor(locale).ui, "");
  return out;
}

/** Picks the best published locale from an Accept-Language header; pseudo-locales are never guessed. */
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
    const exact = PUBLISHED_LOCALES.find((l) => l.toLowerCase() === tag);
    if (exact) return exact;
    const language = PUBLISHED_LOCALES.find(
      (l) => l.toLowerCase().split("-")[0] === tag.split("-")[0],
    );
    if (language) return language;
  }
  return DEFAULT_LOCALE;
}
