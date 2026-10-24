/**
 * The shipped locales, without any catalog. Client code imports this entry (`@xos/i18n/locales`)
 * so that checking a locale never pulls the message catalogs into a browser bundle (A24-009).
 *
 * Section 15 ships two kinds of locale:
 *   - launch locales (en-US, the source, and es-US): complete catalogs, held strict by the tests;
 *   - Beta locales (fr-FR, de-DE, it-IT, pt-BR, ja-JP): machine translated through the Google
 *     Translate pipeline (ADR 0037), so a catalog may be partial or absent. Every key a Beta catalog
 *     lacks falls back to en-US, one key at a time, so a raw key never shows. The language picker marks
 *     them Beta until a native reviewer signs them off in packages/i18n/REVIEW.md.
 */
export const launchLocales = ["en-US", "es-US"] as const;
export const betaLocales = ["fr-FR", "de-DE", "it-IT", "pt-BR", "ja-JP"] as const;
export const locales = [...launchLocales, ...betaLocales] as const;

export type LaunchLocale = (typeof launchLocales)[number];
export type BetaLocale = (typeof betaLocales)[number];
export type Locale = (typeof locales)[number];
export const defaultLocale: LaunchLocale = "en-US";

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function isLaunchLocale(value: string): value is LaunchLocale {
  return (launchLocales as readonly string[]).includes(value);
}

export function isBetaLocale(value: string): value is BetaLocale {
  return (betaLocales as readonly string[]).includes(value);
}
