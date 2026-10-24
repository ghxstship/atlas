/**
 * Display preferences from the settings registry (Section 4.5.6 Preferences and Accessibility, A65-001): the
 * person's text size, contrast, motion, density, single-key shortcuts, date format, units, first day of the
 * week and the zone schedule times show in. Atlas and Gateway resolve them from the person's settings, keep
 * them in one cookie so the server renders the document with them, and set them on the document root as data
 * attributes the styles read.
 */
import type { TimeZoneDisplay } from "./format.ts";
import type { UnitsPreference } from "@xos/i18n/units";

export * from "@xos/i18n/units";
export { displayTimeZone, formatZonedDateTime, type TimeZoneDisplay } from "./format.ts";

export type TextSize = "default" | "large" | "larger";
export type Contrast = "default" | "more";
export type Motion = "system" | "reduce" | "full";
export type Density = "comfortable" | "compact";
export type DateFormat = "locale" | "iso";
/**
 * locale.units (Section 15): "jurisdiction" follows the project's jurisdiction (imperial for the United States,
 * metric otherwise), or a fixed system; resolve it with `resolveUnitSystem` where a value is shown.
 */
export type Units = UnitsPreference;
/**
 * 0 for Sunday (payroll.week_start's default), 1 for Monday. The default is the registry's, so a person who
 * never chose one keeps the cookie empty and nothing resyncs.
 */
export type WeekStart = 0 | 1;

export interface DisplayPreferences {
  readonly textSize: TextSize;
  readonly contrast: Contrast;
  readonly motion: Motion;
  readonly density: Density;
  readonly shortcuts: boolean;
  readonly dateFormat: DateFormat;
  readonly units: Units;
  readonly weekStart: WeekStart;
  /** me.time_zone_display: schedule times in the event's zone (default) or the viewer's own. */
  readonly timeZoneDisplay: TimeZoneDisplay;
}

export const DEFAULT_PREFERENCES: DisplayPreferences = {
  textSize: "default",
  contrast: "default",
  motion: "system",
  density: "comfortable",
  shortcuts: true,
  dateFormat: "locale",
  units: "jurisdiction",
  weekStart: 0,
  timeZoneDisplay: "event",
};

/** The cookie that carries the preferences for server rendering. */
export const PREFERENCES_COOKIE = "xos-prefs";

const YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * The `document.cookie` assignment that keeps the preferences cookie in step with the person's settings. It is
 * set in the browser, not by a server action, so keeping it current never re-renders or interrupts the page.
 * The value holds only letters, digits, dots and bars; an empty value expires the cookie.
 */
export function preferencesCookie(encoded: string, secure: boolean): string {
  const value = /^[a-z0-9.|]*$/.test(encoded) ? encoded : "";
  const age = value === "" ? 0 : YEAR_SECONDS;
  return `${PREFERENCES_COOKIE}=${value}; path=/; max-age=${age}; samesite=lax${secure ? "; secure" : ""}`;
}

/** The registry key each preference reads (packages/schemas/settings). */
export const PREFERENCE_SETTINGS = {
  textSize: "me.text_size",
  contrast: "me.high_contrast",
  motion: "me.reduced_motion",
  density: "shell.density",
  shortcuts: "me.shortcuts_enabled",
  dateFormat: "locale.date_format",
  units: "locale.units",
  weekStart: "payroll.week_start",
  timeZoneDisplay: "me.time_zone_display",
} as const;

const UNITS: readonly Units[] = ["jurisdiction", "imperial", "metric"];
const ZONE_DISPLAYS: readonly TimeZoneDisplay[] = ["event", "viewer"];

type SettingLookup = (key: string) => unknown;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Preferences from resolved setting values, falling back to the defaults for anything unset or unknown. */
export function preferencesFromSettings(
  values: ReadonlyMap<string, unknown> | SettingLookup,
): DisplayPreferences {
  const get: SettingLookup = typeof values === "function" ? values : (key) => values.get(key);
  const week = get(PREFERENCE_SETTINGS.weekStart);
  return {
    textSize: pick(get(PREFERENCE_SETTINGS.textSize), ["default", "large", "larger"], "default"),
    contrast: get(PREFERENCE_SETTINGS.contrast) === true ? "more" : "default",
    motion: pick(get(PREFERENCE_SETTINGS.motion), ["system", "reduce", "full"], "system"),
    density: pick(get(PREFERENCE_SETTINGS.density), ["comfortable", "compact"], "comfortable"),
    shortcuts: get(PREFERENCE_SETTINGS.shortcuts) !== false,
    dateFormat: pick(get(PREFERENCE_SETTINGS.dateFormat), ["locale", "iso"], "locale"),
    units: pick(get(PREFERENCE_SETTINGS.units), UNITS, "jurisdiction"),
    weekStart: week === "monday" ? 1 : 0,
    timeZoneDisplay: pick(get(PREFERENCE_SETTINGS.timeZoneDisplay), ZONE_DISPLAYS, "event"),
  };
}

const CODES: Record<keyof DisplayPreferences, string> = {
  textSize: "t",
  contrast: "c",
  motion: "m",
  density: "d",
  shortcuts: "s",
  dateFormat: "f",
  units: "u",
  weekStart: "w",
  timeZoneDisplay: "z",
};

/** A short cookie value holding only what differs from the defaults, such as `t.large|d.compact`. */
export function encodePreferences(prefs: DisplayPreferences): string {
  const parts: string[] = [];
  for (const key of Object.keys(CODES) as (keyof DisplayPreferences)[]) {
    if (prefs[key] === DEFAULT_PREFERENCES[key]) continue;
    const value = prefs[key];
    const text = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
    parts.push(`${CODES[key]}.${text}`);
  }
  return parts.join("|");
}

/** Reads a cookie value written by encodePreferences; anything it does not recognize stays at its default. */
export function decodePreferences(raw: string | undefined | null): DisplayPreferences {
  if (!raw) return DEFAULT_PREFERENCES;
  const found = new Map<string, string>();
  for (const part of raw.split("|")) {
    const [code, value] = part.split(".");
    if (code && value !== undefined) found.set(code, value);
  }
  const week = found.get(CODES.weekStart);
  return {
    textSize: pick(found.get(CODES.textSize), ["default", "large", "larger"], "default"),
    contrast: pick(found.get(CODES.contrast), ["default", "more"], "default"),
    motion: pick(found.get(CODES.motion), ["system", "reduce", "full"], "system"),
    density: pick(found.get(CODES.density), ["comfortable", "compact"], "comfortable"),
    shortcuts: found.get(CODES.shortcuts) !== "0",
    dateFormat: pick(found.get(CODES.dateFormat), ["locale", "iso"], "locale"),
    units: pick(found.get(CODES.units), UNITS, "jurisdiction"),
    weekStart: week === "1" ? 1 : 0,
    timeZoneDisplay: pick(found.get(CODES.timeZoneDisplay), ZONE_DISPLAYS, "event"),
  };
}

/**
 * The document root's data attributes for the preferences the styles read: data-text-size, data-contrast,
 * data-motion, data-density and data-shortcuts. Defaults add nothing.
 */
export function documentAttributes(prefs: DisplayPreferences): Record<string, string> {
  const out: Record<string, string> = {};
  if (prefs.textSize !== "default") out["data-text-size"] = prefs.textSize;
  if (prefs.contrast === "more") out["data-contrast"] = "more";
  if (prefs.motion !== "system") out["data-motion"] = prefs.motion;
  if (prefs.density === "compact") out["data-density"] = "compact";
  if (!prefs.shortcuts) out["data-shortcuts"] = "off";
  return out;
}

const ATTRIBUTES = [
  "data-text-size",
  "data-contrast",
  "data-motion",
  "data-density",
  "data-shortcuts",
];

/** Sets the preference attributes on an element (the document root), removing the ones back at default. */
export function applyDocumentAttributes(element: HTMLElement, prefs: DisplayPreferences): void {
  const next = documentAttributes(prefs);
  for (const name of ATTRIBUTES) {
    const value = next[name];
    if (value === undefined) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }
}

/**
 * Whether single-key shortcuts (J, K, /, ?) are on: off while the document root carries
 * data-shortcuts="off" (me.shortcuts_enabled). Shortcuts with Cmd or Ctrl always work.
 */
export function singleKeyShortcutsEnabled(
  doc: Document | undefined = globalThis.document,
): boolean {
  return doc?.documentElement.dataset["shortcuts"] !== "off";
}

const SQUARE_METERS_PER_SQUARE_FOOT = 0.09290304;
const METERS_PER_FOOT = 0.3048;
const METERS_PER_MILE = 1609.344;

/**
 * An area stored in square feet in the person's units (locale.units): square feet, or square meters to one
 * decimal. Callers label the unit from their message catalog, since Intl has no area units.
 */
export function convertArea(
  squareFeet: number,
  units: "imperial" | "metric",
): { readonly value: number; readonly unit: "squareFoot" | "squareMeter" } {
  return units === "metric"
    ? {
        value: Math.round(squareFeet * SQUARE_METERS_PER_SQUARE_FOOT * 10) / 10,
        unit: "squareMeter",
      }
    : { value: squareFeet, unit: "squareFoot" };
}

/**
 * A distance stored in meters in the person's units (locale.units): feet up to 1,000 ft and miles
 * beyond, or meters up to 1 km and kilometers beyond, formatted by Intl for the locale.
 */
export function formatDistance(
  locale: string,
  meters: number,
  units: "imperial" | "metric",
): string {
  const unit = (name: string, value: number, digits: number) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: name,
      maximumFractionDigits: digits,
    }).format(value);
  if (units === "metric") {
    return meters >= 1000 ? unit("kilometer", meters / 1000, 1) : unit("meter", meters, 0);
  }
  const feet = meters / METERS_PER_FOOT;
  return feet >= 1000 ? unit("mile", meters / METERS_PER_MILE, 1) : unit("foot", feet, 0);
}
