import {
  defaultLocale,
  getMessages,
  isLocale,
  pickNamespaces,
  type Messages,
  type Namespace,
} from "@xos/i18n";
import { pseudoCatalog } from "@xos/i18n/pseudo";
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { cache } from "react";
import { LOCALE_COOKIE, formattingLocale, negotiateLocale, type ConsoleLocale } from "./negotiate";
import { precompileMessages } from "./precompile";

/** ICU source messages for a negotiated locale: a shipped catalog, or one derived from en-US for a pseudo-locale. */
export function sourceMessagesFor(locale: ConsoleLocale): Messages {
  return isLocale(locale) ? getMessages(locale) : pseudoCatalog(getMessages("en-US"), locale);
}

const compiled = new Map<ConsoleLocale, Messages>();

/** Messages for next-intl, precompiled with icu-minify once per locale per server process (ADR 0027). */
export function messagesFor(locale: ConsoleLocale): Messages {
  let messages = compiled.get(locale);
  if (messages === undefined) {
    messages = precompileMessages(sourceMessagesFor(locale));
    compiled.set(locale, messages);
  }
  return messages;
}

/**
 * The namespaces console client components read: the console's own copy and the sitemap labels. Server components
 * keep every namespace; test/client-namespaces.test.ts fails when a client component asks for another.
 */
export const CLIENT_NAMESPACES: readonly Namespace[] = ["console", "nav"];

export function clientMessages(locale: ConsoleLocale) {
  return pickNamespaces(messagesFor(locale), CLIENT_NAMESPACES);
}

/**
 * Flat `ui` messages for @xos/ui, which ships only en-US; every other locale, shipped or pseudo, passes its own
 * through XOSProvider.
 */
export function uiMessages(locale: ConsoleLocale): Record<string, string> | undefined {
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
 * The locale negotiated for this request, pseudo-locales included outside production. It picks the messages and the
 * document language and direction; read once per request.
 */
export const negotiatedLocale = cache(async (): Promise<ConsoleLocale> => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return negotiateLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
    production: process.env.NODE_ENV === "production",
  });
});

/**
 * next-intl's `locale` is the one every formatter reads, so it is the formatting locale: a pseudo-locale formats dates
 * and numbers as en-US while its messages stay pseudo.
 */
export default getRequestConfig(async () => {
  const locale = await negotiatedLocale();
  return { locale: formattingLocale(locale), messages: messagesFor(locale) };
});
