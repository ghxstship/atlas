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
import { LOCALE_COOKIE, negotiateLocale, type GatewayLocale } from "./negotiate";
import { pseudoCatalog } from "./pseudo";

/** Messages for a negotiated locale: a shipped catalog, or one derived from en-US for a pseudo-locale. */
export function messagesFor(locale: GatewayLocale): Messages {
  return isLocale(locale) ? getMessages(locale) : pseudoCatalog(getMessages("en-US"), locale);
}

/**
 * The namespaces Gateway client components read: Gateway's own copy, the sitemap labels (`nav`),
 * personal settings, the shell, view names, help and statuses. Server components keep every
 * namespace; test/client-namespaces.test.ts fails when a client component asks for one outside
 * this list.
 */
export const CLIENT_NAMESPACES: readonly Namespace[] = [
  "gateway",
  "help",
  "nav",
  "settings",
  "shell",
  "status",
  "views",
];

/** The active locale's namespaces the next-intl client provider needs (A24-009). */
export function clientMessages(locale: GatewayLocale) {
  return pickNamespaces(messagesFor(locale), CLIENT_NAMESPACES);
}

/**
 * Flat `ui` messages for @xos/ui, which ships only en-US; every other locale, shipped or pseudo,
 * passes its own through XOSProvider.
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
  walk(messagesFor(locale).ui, "");
  return out;
}

/** next-intl request configuration: negotiates the locale once per request (i18n/negotiate.ts). */
export default getRequestConfig(async () => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = negotiateLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
    production: process.env.NODE_ENV === "production",
  });
  return { locale, messages: messagesFor(locale) };
});
