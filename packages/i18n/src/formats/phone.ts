import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { regionOfLocale } from "./units";

/**
 * Phone numbers (Section 15): stored in E.164 and shown in national format, through
 * libphonenumber-js (ADR 0001). A number from the viewer's own country reads in its national
 * format; any other number reads in international format so it can still be dialed. Server code
 * only where route budgets matter: the metadata is about 80 KB.
 */

const REGION = /^[A-Z]{2}$/;

/**
 * The country a locale implies (en-US and es-US give US), or null for a bare language or a UN M.49
 * region such as es-419. Goes through regionOfLocale, so on Hermes, which has no `Intl.Locale`,
 * Compass still reads the region from the tag and a typed national number keeps its country.
 */
export function regionFromLocale(locale: string): string | null {
  try {
    const region = regionOfLocale(locale);
    return region && REGION.test(region) ? region : null;
  } catch {
    return null;
  }
}

/**
 * Parses what a person typed into E.164, reading a number without a country code as a number of
 * `defaultRegion`. Null when it is not a valid number.
 */
export function toE164(input: string, defaultRegion?: string | null): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const region =
    defaultRegion && REGION.test(defaultRegion) ? (defaultRegion as CountryCode) : undefined;
  const parsed = parsePhoneNumberFromString(trimmed, region);
  return parsed?.isValid() ? parsed.number : null;
}

/** Country of an E.164 number, or null when it does not parse. */
export function phoneCountry(e164: string): string | null {
  return parsePhoneNumberFromString(e164)?.country ?? null;
}

/**
 * An E.164 number for display: national format when it belongs to the viewer's region,
 * international format otherwise. A value that does not parse is shown as stored.
 */
export function formatPhone(e164: string, viewerRegion?: string | null): string {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  return viewerRegion && parsed.country === viewerRegion
    ? parsed.formatNational()
    : parsed.formatInternational();
}

/** A tel: link for an E.164 number. */
export function phoneHref(e164: string): string {
  return `tel:${e164.replace(/[^+0-9]/g, "")}`;
}
