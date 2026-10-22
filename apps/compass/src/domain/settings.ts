/**
 * The registered settings Compass applies (Section 4.5.6, A65-001), from app.resolve_settings for the person in
 * their org and current project: the language, personal accessibility (text size, contrast, motion, haptics,
 * sounds), units, and the org's clock, kiosk and claiming rules. The server enforces the org rules again
 * (migrations 1321 and 1322); here they shape what the device offers before it queues anything.
 */
import { isLocale, type Locale } from "@xos/i18n/locales";
import type { ThemeOptions } from "@xos/ui-native/theme";

/** Resolved setting values by key; empty until the first download (every rule then falls back to its default). */
export type ResolvedValues = ReadonlyMap<string, unknown>;

export const NO_VALUES: ResolvedValues = new Map();

/** The settings Compass reads; the device keeps only these. */
export const COMPASS_SETTING_KEYS: readonly string[] = [
  "locale.language",
  "me.text_size",
  "me.high_contrast",
  "me.reduced_motion",
  "me.haptics",
  "me.sounds",
  "locale.units",
  "time.geofence_required",
  "time.kiosk_enabled",
  "time.photo_on_punch",
  "scheduling.open_shift_claiming",
];

/** Rows of app.resolve_settings as values by key. */
export function valuesFromRows(
  rows: readonly {
    readonly setting_key: string;
    readonly value_text: string | null;
    readonly value_boolean: boolean | null;
    readonly value_integer: number | null;
  }[],
): ResolvedValues {
  return new Map(
    rows.map((r) => [r.setting_key, r.value_text ?? r.value_boolean ?? r.value_integer ?? null]),
  );
}

/**
 * Rows of app.resolve_settings as the values the device keeps: the keys Compass reads, without the platform
 * default of locale.language, which is nobody's choice, so the device's own language stands until the person or
 * their org chooses one.
 */
export function compassValuesFromRows(
  rows: readonly (Parameters<typeof valuesFromRows>[0][number] & { readonly source?: string })[],
): ResolvedValues {
  return valuesFromRows(
    rows.filter(
      (r) =>
        COMPASS_SETTING_KEYS.includes(r.setting_key) &&
        !(r.setting_key === "locale.language" && r.source === "Default"),
    ),
  );
}

/**
 * The language Compass renders in: locale.language as resolved for the person (their org's when it locks it,
 * else their own from any device or shell, else their org's), or null to keep the device's language.
 */
export function languageOf(values: ResolvedValues): Locale | null {
  const value = values.get("locale.language");
  return typeof value === "string" && isLocale(value) ? value : null;
}

/** Text size, contrast and motion for the native theme (me.text_size, me.high_contrast, me.reduced_motion). */
export function themeOptionsOf(values: ResolvedValues): ThemeOptions {
  const size = values.get("me.text_size");
  return {
    textScale: size === "larger" ? 1.3 : size === "large" ? 1.15 : 1,
    highContrast: values.get("me.high_contrast") === true,
    reduceMotion: values.get("me.reduced_motion") === "reduce",
  };
}

/**
 * The resolved values with a personal setting the person changed on this device (a queued
 * set_personal_setting), before the outbox sends it and a later resolve confirms it. A switch bound to a
 * resolved value, such as Haptics (me.haptics), then shows the change at once instead of snapping back;
 * queuedSettings.ts keeps it there until the server has it. Returns the same map for any other mutation or a
 * key Compass does not read.
 */
export function withQueuedSetting(
  values: ResolvedValues,
  input: {
    readonly op: string;
    readonly target?: string | undefined;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): ResolvedValues {
  if (input.op !== "rpc" || input.target !== "set_personal_setting") return values;
  const key = input.payload["p_setting_key"];
  if (typeof key !== "string" || !COMPASS_SETTING_KEYS.includes(key)) return values;
  const next = new Map(values);
  next.set(
    key,
    input.payload["p_value_text"] ??
      input.payload["p_value_boolean"] ??
      input.payload["p_value_integer"] ??
      null,
  );
  return next;
}

/** Haptic feedback follows the person's me.haptics once known, and the device switch until then. */
export function hapticsOn(device: boolean, values: ResolvedValues): boolean {
  const value = values.get("me.haptics");
  return typeof value === "boolean" ? value : device;
}

/** The camera's shutter sound follows me.sounds (on unless the person turned sounds off). */
export function soundsOn(values: ResolvedValues): boolean {
  return values.get("me.sounds") !== false;
}

/**
 * A phone clock-in needs a location inside the project's geofence while time.geofence_required is on (the
 * default) and the project has one.
 */
export function requiresGeofence(values: ResolvedValues, geofences: number): boolean {
  return geofences > 0 && values.get("time.geofence_required") !== false;
}

/** The kiosk's rules: kiosks on (time.kiosk_enabled) and a photo on every punch (time.photo_on_punch). */
export function kioskRules(values: ResolvedValues): { enabled: boolean; photoOnPunch: boolean } {
  return {
    enabled: values.get("time.kiosk_enabled") === true,
    photoOnPunch: values.get("time.photo_on_punch") === true,
  };
}

export type ClaimRule = "first-come" | "approval" | "seniority";

/** How an open shift is claimed on the project (scheduling.open_shift_claiming); approval by default. */
export function claimRuleOf(values: ResolvedValues): ClaimRule {
  const value = values.get("scheduling.open_shift_claiming");
  return value === "first-come" || value === "seniority" ? value : "approval";
}

const METERS_PER_FOOT = 0.3048;
const METERS_PER_MILE = 1609.344;

/** A distance in the person's units (locale.units, imperial by default), formatted for the locale. */
export function formatDistance(locale: string, meters: number, values: ResolvedValues): string {
  const unit = (name: string, value: number, digits: number) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: name,
      maximumFractionDigits: digits,
    }).format(value);
  if (values.get("locale.units") === "metric") {
    return meters >= 1000 ? unit("kilometer", meters / 1000, 1) : unit("meter", meters, 0);
  }
  const feet = meters / METERS_PER_FOOT;
  return feet >= 1000 ? unit("mile", meters / METERS_PER_MILE, 1) : unit("foot", feet, 0);
}
