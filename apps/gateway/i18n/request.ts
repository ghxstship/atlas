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
import { ownLanguage } from "@/lib/shell/personal-settings";
import {
  LOCALE_COOKIE,
  cookieLocale,
  formattingLocale,
  negotiateLocale,
  type GatewayLocale,
} from "./negotiate";
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
    // A Beta catalog not loaded yet reads en-US; it stays out of the cache so the loaded one replaces it.
    if (!isBetaLocale(locale) || isBetaCatalogLoaded(locale)) compiled.set(locale, messages);
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
 * document language and direction, and the language picker's value. When this device chose no language, the signed-in
 * person's own locale.language takes part. Read once per request; a Beta locale's catalog is loaded before it returns.
 */
export const negotiatedLocale = cache(async (): Promise<GatewayLocale> => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const cookie = cookieStore.get(LOCALE_COOKIE)?.value;
  const production = process.env.NODE_ENV === "production";
  const locale = negotiateLocale({
    cookie,
    acceptLanguage: headerStore.get("accept-language"),
    production,
    own: cookieLocale(cookie, production) === null ? await ownLanguage() : null,
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
