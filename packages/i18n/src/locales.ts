/**
 * The shipped locales, without any catalog. Client code imports this entry (`@xos/i18n/locales`)
 * so that checking a locale never pulls the message catalogs into a browser bundle (A24-009).
 */
export const locales = ["en-US", "es-US"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en-US";

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}
