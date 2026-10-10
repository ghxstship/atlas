import { defaultLocale, getMessages, isLocale } from "@xos/i18n";

/**
 * Component copy (ADR 0010, D6). Every visible string comes from the `ui` namespace of the
 * @xos/i18n catalogs; keys are written without the namespace (`money.unpriced`) and this helper
 * prefixes `ui.`. Locales outside the shipped list (pseudo-locales, other languages) fall back to
 * en-US for any key their messages do not supply.
 */

export type MessageVars = Record<string, string | number>;
export type Messages = Record<string, string>;

const NAMESPACE = "ui";

function flatten(value: unknown, prefix: string, out: Messages): Messages {
  if (typeof value === "string") {
    out[prefix] = value;
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

const catalogs = new Map<string, Messages>();

/** The flat `ui` catalog of a shipped locale, keyed without the namespace. */
export function catalogFor(locale: string): Messages {
  const shipped = isLocale(locale) ? locale : defaultLocale;
  let catalog = catalogs.get(shipped);
  if (catalog === undefined) {
    catalog = flatten((getMessages(shipped) as Record<string, unknown>)[NAMESPACE], "", {});
    catalogs.set(shipped, catalog);
  }
  return catalog;
}

/** Flattens a nested `ui` catalog (such as a pseudo-locale file) into the flat form `configure` takes. */
export function flattenMessages(nested: unknown): Messages {
  const root =
    typeof nested === "object" && nested !== null && NAMESPACE in nested
      ? (nested as Record<string, unknown>)[NAMESPACE]
      : nested;
  return flatten(root, "", {});
}

export interface XOSConfig {
  locale?: string;
  messages?: Record<string, string>;
}

const config: { locale: string; messages: Messages } = { locale: defaultLocale, messages: {} };

/** Sets the locale for Intl formatting and merges messages over the catalog, for code outside a provider. */
export function configure(next: XOSConfig): void {
  if (next.locale !== undefined) config.locale = next.locale;
  if (next.messages !== undefined) config.messages = { ...config.messages, ...next.messages };
}

/** The locale and message overrides set by `configure`. */
export function currentConfig(): { locale: string; messages: Messages } {
  return config;
}

/** Fills `{name}` arguments; numbers are formatted for the locale, as an ICU simple argument is. */
export function format(message: string, locale: string, vars?: MessageVars): string {
  if (vars === undefined) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) return match;
    return typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : value;
  });
}

/** Looks up a `ui` message for a locale, with overrides first, and fills its arguments. Unknown keys return the key. */
export function translate(
  locale: string,
  key: string,
  vars?: MessageVars,
  overrides: Messages = {},
): string {
  const message = overrides[key] ?? catalogFor(locale)[key] ?? catalogFor(defaultLocale)[key];
  return message === undefined ? key : format(message, locale, vars);
}

/** Looks up a catalog message and fills its arguments, using the locale set by `configure`. */
export function t(key: string, vars?: MessageVars): string {
  return translate(config.locale, key, vars, config.messages);
}

/** Right-to-left scripts, matched on the language subtag; `ar-XB` is the right-to-left pseudo-locale. */
const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ps", "ur", "yi", "dv", "ckb"]);

export function directionOf(locale: string): "ltr" | "rtl" {
  const language = locale.split("-")[0]?.toLowerCase() ?? "";
  return RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
}
