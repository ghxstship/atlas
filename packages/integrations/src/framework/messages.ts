import { defaultLocale, isLaunchLocale, type LaunchLocale, type Locale } from "@xos/i18n/locales";
import enUS from "@xos/i18n/messages/en-US/integrations.json" with { type: "json" };
import esUS from "@xos/i18n/messages/es-US/integrations.json" with { type: "json" };

/** Copy the integrations send to people outside Atlas (chat messages), from the `integrations` namespace. */
export type Translate = (key: string, args?: Readonly<Record<string, string | number>>) => string;

type Tree = { readonly [key: string]: string | Tree };

/**
 * The integrations namespace of each locale, read from its own file, so the Edge Functions that send chat
 * copy load this namespace only, never every catalog (A85, cold starts). A Beta locale (ADR 0053) reads en-US.
 */
const catalogs: Readonly<Record<LaunchLocale, Tree>> = { "en-US": enUS, "es-US": esUS };

/**
 * A translator over the `integrations` namespace. Messages use simple `{name}` arguments only. A
 * missing key or argument throws, so a raw key or a stray brace never reaches a channel.
 */
export function integrationsTranslator(locale: Locale): Translate {
  const catalog = catalogs[isLaunchLocale(locale) ? locale : defaultLocale] as Tree | undefined;
  if (typeof catalog !== "object")
    throw new Error(`The ${locale} catalog has no integrations namespace.`);
  return (key, args = {}) => {
    let node: string | Tree | undefined = catalog;
    for (const segment of key.split(".")) {
      node = typeof node === "object" ? node[segment] : undefined;
    }
    if (typeof node !== "string")
      throw new Error(`Missing integrations message ${key} in ${locale}.`);
    return node.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = args[name];
      if (value === undefined)
        throw new Error(`Message integrations.${key} needs the ${name} argument.`);
      return String(value);
    });
  };
}
