import {
  defaultLocale,
  getMessages,
  pickNamespaces,
  type Messages,
  type Namespace,
} from "@xos/i18n";
import type { Locale } from "@xos/i18n/locales";
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { cache } from "react";
import { LOCALE_COOKIE, negotiateLocale } from "./negotiate";
import { precompileMessages } from "./precompile";

const compiled = new Map<Locale, Messages>();

/** Messages for next-intl, precompiled with icu-minify once per locale per server process (ADR 0027). */
export function messagesFor(locale: Locale): Messages {
  let messages = compiled.get(locale);
  if (messages === undefined) {
    messages = precompileMessages(getMessages(locale));
    compiled.set(locale, messages);
  }
  return messages;
}

/**
 * The namespaces console client components read: the console's own copy and the sitemap labels. Server components
 * keep every namespace; test/client-namespaces.test.ts fails when a client component asks for another.
 */
export const CLIENT_NAMESPACES: readonly Namespace[] = ["console", "nav"];

export function clientMessages(locale: Locale) {
  return pickNamespaces(messagesFor(locale), CLIENT_NAMESPACES);
}

/** Flat `ui` messages for @xos/ui, which ships only en-US; es-US passes its own through XOSProvider. */
export function uiMessages(locale: Locale): Record<string, string> | undefined {
  if (locale === defaultLocale) return undefined;
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

/** The locale negotiated for this request; read once per request. */
export const negotiatedLocale = cache(async (): Promise<Locale> => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return negotiateLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });
});

export default getRequestConfig(async () => {
  const locale = await negotiatedLocale();
  return { locale, messages: messagesFor(locale) };
});
