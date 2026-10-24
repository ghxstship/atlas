/**
 * i18next over the shared @xos/i18n catalogs (Section 15). Messages use single-brace ICU arguments
 * ("{count} changes"), so interpolation uses single braces. Plural forms are separate keys chosen in code
 * (queuedOne, queuedOther).
 *
 * Only the device's locale and en-US (the fallback) are handed to i18next, so the app never holds every
 * catalog at once. The device locale is matched against the launch locales: Compass has no language
 * picker, and the Beta locales (ADR 0053) are chosen in Atlas or Gateway, never guessed. A language the
 * person or their org chose (locale.language) is added when Compass switches to it, a Beta one loaded
 * on demand.
 */
import {
  defaultLocale,
  getMessages,
  isLaunchLocale,
  launchLocales,
  type LaunchLocale,
  type Locale,
} from "@xos/i18n";
import { loadMessages } from "@xos/i18n/load";
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

/** The language the latest applyLanguage asked for, so an earlier call still loading never wins. */
let wanted: Locale | null = null;

/**
 * Renders in a chosen language (locale.language), or in the device's language when nobody chose one. A
 * language i18next was not started with gets its catalog first (a Beta one loads on demand, ADR 0053), so
 * the switch never shows en-US where the catalog has a translation.
 */
export async function applyLanguage(locale: Locale | null): Promise<void> {
  const next = locale ?? deviceLocale();
  wanted = next;
  if (!i18next.isInitialized) return;
  if (!i18next.hasResourceBundle(next, "translation")) {
    const messages = await loadMessages(next);
    if (wanted !== next) return;
    i18next.addResourceBundle(next, "translation", messages, true, true);
  }
  if (i18next.language !== next) await i18next.changeLanguage(next);
}

/** Picks the One or Other form of a count message. */
export function countKey(base: string, count: number): string {
  return count === 1 ? `${base}One` : `${base}Other`;
}
