/**
 * i18next over the shared @xos/i18n catalogs (Section 15). Messages use single-brace ICU arguments
 * ("{count} changes"), so interpolation uses single braces. Plural forms are separate keys chosen in code
 * (queuedOne, queuedOther).
 */
import { defaultLocale, getMessages, isLocale, locales, type Locale } from "@xos/i18n";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

export function deviceLocale(): Locale {
  const tag = Intl.DateTimeFormat().resolvedOptions().locale;
  if (isLocale(tag)) return tag;
  const language = tag.split("-")[0];
  return locales.find((l) => l.startsWith(`${language}-`)) ?? defaultLocale;
}

export function initI18n(locale: Locale = deviceLocale()): typeof i18next {
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      lng: locale,
      fallbackLng: defaultLocale,
      resources: Object.fromEntries(locales.map((l) => [l, { translation: getMessages(l) }])),
      interpolation: { prefix: "{", suffix: "}", escapeValue: false },
    });
  }
  return i18next;
}

/** Renders in a chosen language (locale.language), or in the device's language when nobody chose one. */
export function applyLanguage(locale: Locale | null): void {
  const next = locale ?? deviceLocale();
  if (i18next.isInitialized && i18next.language !== next) void i18next.changeLanguage(next);
}

/** Picks the One or Other form of a count message. */
export function countKey(base: string, count: number): string {
  return count === 1 ? `${base}One` : `${base}Other`;
}
