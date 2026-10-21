import {
  defaultLocale,
  getMessages,
  isLocale,
  pickNamespaces,
  type Messages,
  type Namespace,
} from "@xos/i18n";
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { cache } from "react";
import { LOCALE_COOKIE, formattingLocale, negotiateLocale, type GatewayLocale } from "./negotiate";
import { precompileMessages } from "./precompile";
import { pseudoCatalog } from "./pseudo";

/** ICU source messages for a negotiated locale: a shipped catalog, or one derived from en-US for a pseudo-locale. */
export function sourceMessagesFor(locale: GatewayLocale): Messages {
  return isLocale(locale) ? getMessages(locale) : pseudoCatalog(getMessages("en-US"), locale);
}

const compiled = new Map<GatewayLocale, Messages>();

/**
 * Messages for next-intl, precompiled with icu-minify as in Atlas (ADR 0027): next.config.ts points
 * `use-intl/format-message` at its format-only build, so neither the server nor the browser ships
 * or runs the ICU parser (about 10 KB gzip on every page). Compiled once per locale per server
 * process.
 */
export function messagesFor(locale: GatewayLocale): Messages {
  let messages = compiled.get(locale);
  if (messages === undefined) {
    messages = precompileMessages(sourceMessagesFor(locale));
    compiled.set(locale, messages);
  }
  return messages;
}

/**
 * The namespaces Gateway client components read: second factors and passkeys (`authSecurity`, shared
 * with Atlas), Gateway's own copy, the sitemap labels (`nav`), personal settings, the shell, view names,
 * help, statuses and Work Details. Server components keep every namespace;
 * test/client-namespaces.test.ts fails when a client component asks for one outside this list.
 */
export const CLIENT_NAMESPACES: readonly Namespace[] = [
  "authSecurity",
  "gateway",
  "help",
  "nav",
  "settings",
  "shell",
  "status",
  "views",
  "workDetails",
];

/** The active locale's namespaces the next-intl client provider needs (A24-009). */
export function clientMessages(locale: GatewayLocale) {
  return pickNamespaces(messagesFor(locale), CLIENT_NAMESPACES);
}

/**
 * Flat `ui` messages for @xos/ui, which ships only en-US; every other locale, shipped or pseudo,
 * passes its own through XOSProvider. @xos/ui fills `{name}` itself, so these stay source text.
 */
export function uiMessages(locale: GatewayLocale): Record<string, string> | undefined {
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
 * document language and direction, and the language picker's value. Read once per request.
 */
export const negotiatedLocale = cache(async (): Promise<GatewayLocale> => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return negotiateLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
    production: process.env.NODE_ENV === "production",
  });
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
