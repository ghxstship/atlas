import {
  defaultLocale,
  getMessages,
  isBetaCatalogLoaded,
  isBetaLocale,
  isLocale,
  pickNamespaces,
  type Messages,
  type Namespace,
} from "@xos/i18n";
import { loadMessages } from "@xos/i18n/load";
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { cache } from "react";
import { LOCALE_COOKIE, formattingLocale, negotiateLocale, type AtlasLocale } from "./negotiate";
import { precompileMessages } from "./precompile";
import { pseudoCatalog } from "./pseudo";

/** ICU source messages for a negotiated locale: a shipped catalog, or one derived from en-US for a pseudo-locale. */
export function sourceMessagesFor(locale: AtlasLocale): Messages {
  return isLocale(locale) ? getMessages(locale) : pseudoCatalog(getMessages("en-US"), locale);
}

const compiled = new Map<AtlasLocale, Messages>();

/**
 * Messages for next-intl, precompiled with icu-minify (ADR 0027): next.config.ts points
 * `use-intl/format-message` at its format-only build, so neither the server nor the browser ships
 * or runs the ICU parser. Compiled once per locale per server process.
 */
export function messagesFor(locale: AtlasLocale): Messages {
  let messages = compiled.get(locale);
  if (messages === undefined) {
    messages = precompileMessages(sourceMessagesFor(locale));
    // A Beta catalog not loaded yet reads en-US; it stays out of the cache so the loaded one replaces it.
    if (!isBetaLocale(locale) || isBetaCatalogLoaded(locale)) compiled.set(locale, messages);
  }
  return messages;
}

/**
 * Namespaces Atlas client components never read: other surfaces' copy (Gateway, docs, Compass,
 * email) and `ui`, which @xos/ui takes through XOSProvider. Atlas client components resolve keys
 * across every module namespace (the shell's sitemap labels, action forms' success keys), so the
 * split here is by surface rather than by page.
 */
const SERVER_ONLY_NAMESPACES: readonly Namespace[] = [
  "compass",
  "docs",
  "documents",
  "email",
  "gateway",
  "handoff",
  "ui",
];

/** The active locale's namespaces the next-intl client provider needs (A24-009). */
export function clientMessages(locale: AtlasLocale) {
  const messages = messagesFor(locale);
  const keep = (Object.keys(messages) as Namespace[]).filter(
    (ns) => !SERVER_ONLY_NAMESPACES.includes(ns),
  );
  return pickNamespaces(messages, keep);
}

/**
 * Flat `ui` messages for @xos/ui, which ships only en-US; every other locale, shipped or pseudo,
 * passes its own through XOSProvider. @xos/ui fills `{name}` itself, so these stay source text.
 */
export function uiMessages(locale: AtlasLocale): Record<string, string> | undefined {
  if (locale === defaultLocale) return undefined;
  const out: Record<string, string> = {};
  const walk = (value: unknown, prefix: string) => {
    if (typeof value === "string") out[prefix] = value;
    else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}.${k}` : k);
    }
  };
  walk(sourceMessagesFor(locale).ui, "");
  return out;
}

/**
 * The locale negotiated for this request (i18n/negotiate.ts), pseudo-locales included. It picks the messages, the
 * document language and direction, and the language picker's value. Read once per request; a Beta locale's
 * catalog is loaded before it returns.
 */
export const negotiatedLocale = cache(async (): Promise<AtlasLocale> => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = negotiateLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
    production: process.env.NODE_ENV === "production",
  });
  // A Beta catalog loads on first use (ADR 0053), before anything in this request reads messages; its
  // untranslated keys read en-US, so no raw key ever shows.
  if (isLocale(locale)) await loadMessages(locale);
  return locale;
});

/**
 * next-intl request configuration. Its `locale` is the one every formatter reads (getFormatter, useFormatter, and
 * getLocale or useLocale handed to Intl and XOSProvider), so it is the formatting locale: a pseudo-locale formats
 * dates and numbers as en-US while its messages stay pseudo (finding A53-001).
 */
export default getRequestConfig(async () => {
  const locale = await negotiatedLocale();
  return { locale: formattingLocale(locale), messages: messagesFor(locale) };
});
