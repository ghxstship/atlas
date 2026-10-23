/**
 * i18next over the shared @xos/i18n catalogs (Section 15). Messages use single-brace ICU arguments
 * ("{count} changes"), so interpolation uses single braces. Plural forms are separate keys chosen in code
 * (queuedOne, queuedOther).
 *
 * Only the device's locale and en-US (the fallback) are handed to i18next, so the app never holds every
 * catalog at once. The device locale is matched against the launch locales: Compass has no language
 * picker, and the Beta locales (ADR 0053) are chosen in Atlas or Gateway, never guessed.
 */
import {
  defaultLocale,
  getMessages,
  isLaunchLocale,
  launchLocales,
  type LaunchLocale,
  type Locale,
} from "@xos/i18n";
import i18next, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";

export function deviceLocale(): LaunchLocale {
  const tag = Intl.DateTimeFormat().resolvedOptions().locale;
  if (isLaunchLocale(tag)) return tag;
  const language = tag.split("-")[0];
  return launchLocales.find((l) => l.startsWith(`${language}-`)) ?? defaultLocale;
}

/** The catalogs i18next gets for a locale: that locale's and en-US, the fallback for any missing key. */
export function resourcesFor(locale: Locale): Resource {
  const resources: Resource = {
    [defaultLocale]: { translation: getMessages(defaultLocale) },
  };
  if (locale !== defaultLocale) resources[locale] = { translation: getMessages(locale) };
  return resources;
}

export function initI18n(locale: Locale = deviceLocale()): typeof i18next {
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      lng: locale,
      fallbackLng: defaultLocale,
      resources: resourcesFor(locale),
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
