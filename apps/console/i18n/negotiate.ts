import { defaultLocale, isLocale, locales, type Locale } from "@xos/i18n/locales";

/**
 * Locale negotiation for the console, as Gateway's without pseudo-locales: the `xos-locale` cookie, then the
 * browser's Accept-Language list, then en-US. URLs carry no locale.
 */
export const LOCALE_COOKIE = "xos-locale";

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

export function negotiateLocale(input: {
  readonly cookie?: string | undefined;
  readonly acceptLanguage?: string | null | undefined;
}): Locale {
  if (input.cookie && isLocale(input.cookie)) return input.cookie;
  for (const range of parseAcceptLanguage(input.acceptLanguage)) {
    const match = matchRange(range);
    if (match) return match;
  }
  return defaultLocale;
}
