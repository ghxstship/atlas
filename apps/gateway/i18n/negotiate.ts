import { defaultLocale, isLocale, locales, type Locale } from "@xos/i18n/locales";
import { isPseudoLocale, type PseudoLocale } from "./pseudo";

/**
 * Locale negotiation for Gateway. URLs carry no locale (Section 4.5.8 routes), so
 * the locale comes from, in order: the person's choice on this device in the `xos-locale` cookie,
 * their own locale.language saved on any device or shell (Section 4.5.6, A65-001), then the
 * browser's Accept-Language list, then en-US. Pseudo-locales are accepted from the cookie only, and
 * only outside production, so they never reach a customer.
 */

export const LOCALE_COOKIE = "xos-locale";

export type GatewayLocale = Locale | PseudoLocale;

interface Ranged {
  readonly tag: string;
  readonly q: number;
}

/** Accept-Language entries by preference (RFC 9110 quality values), highest first. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  const ranges: Ranged[] = header.split(",").flatMap((part) => {
    const [tag, ...params] = part.trim().split(";");
    if (!tag) return [];
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
    return Number.isFinite(q) && q > 0 ? [{ tag: tag.trim(), q }] : [];
  });
  return ranges.sort((a, b) => b.q - a.q).map((r) => r.tag);
}

/** The shipped locale that best serves one language range (`es-MX` and `es` resolve to es-US). */
function matchRange(range: string): Locale | undefined {
  const lower = range.toLowerCase();
  const exact = locales.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  const language = lower.split("-")[0];
  return locales.find((l) => l.toLowerCase().split("-")[0] === language);
}

/** The locale this device chose in the cookie, or null when it chose none Gateway can use. */
export function cookieLocale(
  cookie: string | undefined,
  production: boolean,
): GatewayLocale | null {
  if (!cookie) return null;
  if (isLocale(cookie)) return cookie;
  return !production && isPseudoLocale(cookie) ? cookie : null;
}

export function negotiateLocale(input: {
  readonly cookie?: string | undefined;
  readonly acceptLanguage?: string | null | undefined;
  readonly production: boolean;
  /** The person's own locale.language from their personal settings, when they saved one. */
  readonly own?: string | null | undefined;
}): GatewayLocale {
  const chosen = cookieLocale(input.cookie, input.production);
  if (chosen) return chosen;
  if (input.own && isLocale(input.own)) return input.own;
  for (const range of parseAcceptLanguage(input.acceptLanguage)) {
    const match = matchRange(range);
    if (match) return match;
  }
  return defaultLocale;
}

/** Locales the language picker offers: the shipped ones, plus the pseudo-locales in development. */
export function selectableLocales(production: boolean): GatewayLocale[] {
  return production ? [...locales] : [...locales, "en-XA", "ar-XB"];
}

/** Writing direction of a locale (ar-XB is the right-to-left pseudo-locale). */
export function localeDirection(locale: GatewayLocale): "ltr" | "rtl" {
  return locale === "ar-XB" ? "rtl" : "ltr";
}

/** The BCP 47 tag Intl formatting uses for a locale; pseudo-locales format like their source. */
export function formattingLocale(locale: GatewayLocale): Locale {
  return isPseudoLocale(locale) ? defaultLocale : locale;
}
