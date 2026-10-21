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
import { orgLanguage } from "@/lib/shell/org-language";
import { ROUTE_ORG_HEADER } from "@/lib/shell/route-org";
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
    compiled.set(locale, messages);
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
 * document language and direction, and the language picker's value. Inside an org (the route's org, which the
 * proxy names in ROUTE_ORG_HEADER) the viewer's resolved locale.language takes part, with the org's lock.
 * Read once per request.
 */
export const negotiatedLocale = cache(async (): Promise<AtlasLocale> => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const org = headerStore.get(ROUTE_ORG_HEADER);
  return negotiateLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
    production: process.env.NODE_ENV === "production",
    setting: org ? await orgLanguage(org) : null,
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
