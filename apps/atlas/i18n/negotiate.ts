import {
  defaultLocale,
  isLocale,
  launchLocales,
  type LaunchLocale,
  type Locale,
} from "@xos/i18n/locales";
import { isPseudoLocale, type PseudoLocale } from "./pseudo";

/**
 * Locale negotiation for Atlas. URLs carry no locale (Section 4.5.3 routes start with the org), so
 * the locale comes from, in order: the org's locale.language when the org locks it, the person's
 * choice on this device in the `xos-locale` cookie, locale.language as resolved for them in the org
 * (their own value from any device, else the org's), then the browser's Accept-Language list, then
 * en-US. Pseudo-locales are accepted from the cookie only, and only outside production, so they never
 * reach a customer.
 *
 * Beta locales (fr-FR, de-DE, it-IT, pt-BR, ja-JP; Section 15, ADR 0053) are chosen, never guessed:
 * the cookie and a chosen locale.language accept them, but the browser's languages match launch
 * locales only, because a Beta catalog may still read mostly en-US. A Beta locale counts only while a territory that
 * holds it is open (`offered`, ADR 0156): a saved choice of a closed one reads as no choice. The default is closed.
 */

export const LOCALE_COOKIE = "xos-locale";

export type AtlasLocale = Locale | PseudoLocale;

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

/** locale.language as app.resolve_settings gave it for the viewer in the org they are in (Section 4.5.6). */
export interface LanguageSetting {
  readonly value: unknown;
  /** Where the value came from; "Default" when nobody chose one. */
  readonly source: string;
  readonly locked: boolean;
}

/** The shipped locale an org locks everyone to, or null when the org leaves the language to each person. */
export function lockedLocale(
  setting: LanguageSetting | null | undefined,
  offered: readonly Locale[] = launchLocales,
): Locale | null {
  return setting?.locked &&
    typeof setting.value === "string" &&
    isLocale(setting.value) &&
    offered.includes(setting.value)
    ? setting.value
    : null;
}

export function negotiateLocale(input: {
  readonly cookie?: string | undefined;
  readonly acceptLanguage?: string | null | undefined;
  readonly production: boolean;
  readonly setting?: LanguageSetting | null | undefined;
  /** The locales offered now (@xos/i18n/offering); launch locales only when not given. */
  readonly offered?: readonly Locale[] | undefined;
}): AtlasLocale {
  const offered = input.offered ?? launchLocales;
  const locked = lockedLocale(input.setting, offered);
  if (locked) return locked;
  const chosen = input.cookie;
  if (chosen) {
    if (isLocale(chosen) && offered.includes(chosen)) return chosen;
    if (!input.production && isPseudoLocale(chosen)) return chosen;
  }
  const setting = input.setting;
  if (setting && setting.source !== "Default" && typeof setting.value === "string") {
    if (isLocale(setting.value) && offered.includes(setting.value)) return setting.value;
  }
  for (const range of parseAcceptLanguage(input.acceptLanguage)) {
    const match = matchRange(range);
    if (match) return match;
  }
  return defaultLocale;
}

/**
 * Locales the language picker offers: the launch ones, the Beta ones of open territories (the picker marks them with
 * `isBetaLocale` from @xos/i18n/locales), plus the pseudo-locales in development.
 */
export function selectableLocales(
  production: boolean,
  offered: readonly Locale[] = launchLocales,
): AtlasLocale[] {
  return production ? [...offered] : [...offered, "en-XA", "ar-XB"];
}

/** Writing direction of a locale (ar-XB is the right-to-left pseudo-locale). */
export function localeDirection(locale: AtlasLocale): "ltr" | "rtl" {
  return locale === "ar-XB" ? "rtl" : "ltr";
}

/** The BCP 47 tag Intl formatting uses for a locale; pseudo-locales format like their source. */
export function formattingLocale(locale: AtlasLocale): Locale {
  return isPseudoLocale(locale) ? defaultLocale : locale;
}
