import { getMessages, isLocale, type Messages } from "@xos/i18n";
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, negotiateLocale, type GatewayLocale } from "./negotiate";
import { pseudoCatalog } from "./pseudo";

/** Messages for a negotiated locale: a shipped catalog, or one derived from en-US for a pseudo-locale. */
export function messagesFor(locale: GatewayLocale): Messages {
  return isLocale(locale) ? getMessages(locale) : pseudoCatalog(getMessages("en-US"), locale);
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
