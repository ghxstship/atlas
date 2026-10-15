import { IntlMessageFormat } from "intl-messageformat";
import { getMessages, type Locale } from "@xos/i18n";

/** Values an ICU message argument accepts. */
export type MessageValue = string | number | Date;
export type MessageArgs = Readonly<Record<string, MessageValue>>;

type Tree = { readonly [key: string]: string | Tree };

function lookup(tree: Tree, path: readonly string[]): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const segment of path) {
    if (typeof node !== "object") return undefined;
    node = node[segment];
  }
  return typeof node === "string" ? node : undefined;
}

/** The `email` namespace of a locale's catalog: the only home of email copy (Section 3.15). */
export function emailCatalog(locale: Locale): Tree {
  const catalog = (getMessages(locale) as unknown as Tree)["email"];
  if (typeof catalog !== "object") throw new Error(`The ${locale} catalog has no email namespace`);
  return catalog;
}

/** True when the email namespace of the locale holds the dotted key. */
export function hasMessage(locale: Locale, key: string): boolean {
  return lookup(emailCatalog(locale), key.split(".")) !== undefined;
}

/**
 * Formats an email message (`email.<key>`) as ICU with the given arguments. Dates are formatted in
 * the recipient's time zone. A missing key or argument throws: an email never ships a raw key.
 */
export function formatMessage(
  locale: Locale,
  key: string,
  args: MessageArgs = {},
  timeZone = "UTC",
): string {
  const message = lookup(emailCatalog(locale), key.split("."));
  if (message === undefined) throw new Error(`Missing email message ${key} in ${locale}`);
  const formatter = new IntlMessageFormat(message, locale, undefined, {
    formatters: {
      getNumberFormat: (loc, options) => new Intl.NumberFormat(loc, options),
      getDateTimeFormat: (loc, options) => new Intl.DateTimeFormat(loc, { ...options, timeZone }),
      getPluralRules: (loc, options) => new Intl.PluralRules(loc, options),
    },
  });
  const result = formatter.format(args as Record<string, MessageValue>);
  if (typeof result !== "string") throw new Error(`Email message ${key} must format to text`);
  return result;
}

/** Binds a locale and time zone, so templates call `t(key, args)`. */
export type Translate = (key: string, args?: MessageArgs) => string;

export function translator(locale: Locale, timeZone = "UTC"): Translate {
  return (key, args) => formatMessage(locale, key, args, timeZone);
}
