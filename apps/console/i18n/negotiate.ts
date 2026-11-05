import {
  defaultLocale,
  isLocale,
  launchLocales,
  type LaunchLocale,
  type Locale,
} from "@xos/i18n/locales";
import { isPseudoLocale, type PseudoLocale } from "@xos/i18n/pseudo";

/**
 * Locale negotiation for the console, as Gateway's: the `xos-locale` cookie, then the browser's Accept-Language
 * list, then en-US. URLs carry no locale. Beta locales (ADR 0053) are chosen, never guessed: the cookie accepts
 * them, but the browser's languages match launch locales only. Pseudo-locales are accepted from the cookie only,
 * and only outside production, so they never reach an operator.
 */
export const LOCALE_COOKIE = "xos-locale";

export type ConsoleLocale = Locale | PseudoLocale;

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

/** The launch locale that best serves one language range (`es-MX` and `es` resolve to es-US). */
function matchRange(range: string): LaunchLocale | undefined {
  const lower = range.toLowerCase();
  const exact = launchLocales.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  const language = lower.split("-")[0];
  return launchLocales.find((l) => l.toLowerCase().split("-")[0] === language);
}

export function negotiateLocale(input: {
  readonly cookie?: string | undefined;
  readonly acceptLanguage?: string | null | undefined;
  readonly production: boolean;
}): ConsoleLocale {
  if (input.cookie && isLocale(input.cookie)) return input.cookie;
  if (input.cookie && !input.production && isPseudoLocale(input.cookie)) return input.cookie;
  for (const range of parseAcceptLanguage(input.acceptLanguage)) {
    const match = matchRange(range);
    if (match) return match;
  }
  return defaultLocale;
}

/** Writing direction of a locale (ar-XB is the right-to-left pseudo-locale). */
export function localeDirection(locale: ConsoleLocale): "ltr" | "rtl" {
  return locale === "ar-XB" ? "rtl" : "ltr";
}

/** The BCP 47 tag Intl formatting uses for a locale; pseudo-locales format like their source. */
export function formattingLocale(locale: ConsoleLocale): Locale {
  return isPseudoLocale(locale) ? defaultLocale : locale;
}
