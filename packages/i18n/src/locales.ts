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
 *
 * Shipping a locale is not offering it. A Beta locale is a choice only while a territory that holds it is open
 * (private.territories, ADR 0160), because a language with the ability to order in it is a sign of offering XOS there
 * (GDPR Recital 23). Readers take the offered list from `offeredLocaleList`, whose default is the launch locales.
 */
export const launchLocales = ["en-US", "es-US"] as const;
export const betaLocales = ["fr-FR", "de-DE", "it-IT", "pt-BR", "ja-JP"] as const;
export const locales = [...launchLocales, ...betaLocales] as const;

export type LaunchLocale = (typeof launchLocales)[number];
export type BetaLocale = (typeof betaLocales)[number];
export type Locale = (typeof locales)[number];
export const defaultLocale: LaunchLocale = "en-US";

/**
 * The locales offered as choices, in catalog order: the launch locales always, then those of the open territories that
 * this build ships. A locale no build ships is ignored, so a configuration mistake never reaches a catalog lookup.
 */
export function offeredLocaleList(configured: readonly string[] = []): Locale[] {
  return locales.filter(
    (l) => (launchLocales as readonly string[]).includes(l) || configured.includes(l),
  );
}

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function isLaunchLocale(value: string): value is LaunchLocale {
  return (launchLocales as readonly string[]).includes(value);
}

export function isBetaLocale(value: string): value is BetaLocale {
  return (betaLocales as readonly string[]).includes(value);
}
