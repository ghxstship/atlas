/**
 * Units of measure (Section 15): "The unit system follows the project jurisdiction (imperial for US, metric
 * otherwise) with per-user override." Values are stored in one fixed unit each (weather readings in mph, miles
 * and degrees Fahrenheit; GPS accuracy in meters) and converted only for display and input, so a stored value
 * never depends on who entered it.
 *
 * A separate entry (`@xos/i18n/units`) with no dependencies, so client components and Compass can import it
 * without the phone metadata of `@xos/i18n/formats`.
 */

const unitFormats = new Map<string, Intl.NumberFormat>();

/** A measurement with an Intl unit (`meter`, `pound`, `fahrenheit`), the formatter cached per locale. */
export function formatUnit(
  locale: string,
  value: number,
  unit: string,
  maximumFractionDigits = 1,
): string {
  const key = `${locale}|${unit}|${maximumFractionDigits}`;
  let format = unitFormats.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale, { style: "unit", unit, maximumFractionDigits });
    unitFormats.set(key, format);
  }
  return format.format(value);
}

export type UnitSystem = "imperial" | "metric";
/** locale.units: follow the project's jurisdiction, or a fixed system the org or person chose. */
export type UnitsPreference = "jurisdiction" | UnitSystem;

/** The Intl units this module converts between. */
export type MeasureUnit =
  | "meter"
  | "kilometer"
  | "foot"
  | "mile"
  | "kilogram"
  | "pound"
  | "celsius"
  | "fahrenheit"
  | "kilometer-per-hour"
  | "mile-per-hour";

export type Quantity = "length" | "distance" | "weight" | "temperature" | "speed";

/** The unit each quantity shows in, per system. */
const DISPLAY: Record<Quantity, Record<UnitSystem, MeasureUnit>> = {
  length: { metric: "meter", imperial: "foot" },
  distance: { metric: "kilometer", imperial: "mile" },
  weight: { metric: "kilogram", imperial: "pound" },
  temperature: { metric: "celsius", imperial: "fahrenheit" },
  speed: { metric: "kilometer-per-hour", imperial: "mile-per-hour" },
};

const QUANTITY: Record<MeasureUnit, Quantity> = {
  meter: "length",
  foot: "length",
  kilometer: "distance",
  mile: "distance",
  kilogram: "weight",
  pound: "weight",
  celsius: "temperature",
  fahrenheit: "temperature",
  "kilometer-per-hour": "speed",
  "mile-per-hour": "speed",
};

/** Size of each linear unit in its SI base (meters, kilograms, meters per second). */
const FACTOR: Partial<Record<MeasureUnit, number>> = {
  meter: 1,
  kilometer: 1000,
  foot: 0.3048,
  mile: 1609.344,
  kilogram: 1,
  pound: 0.45359237,
  "kilometer-per-hour": 1000 / 3600,
  "mile-per-hour": 1609.344 / 3600,
};

/**
 * Regions that measure in imperial units day to day. Section 15 names the United States; Liberia and
 * Myanmar are the other two (CLDR measurement system "US").
 */
const IMPERIAL_REGIONS = new Set(["US", "LR", "MM"]);

/** The unit system of a jurisdiction or locale region: imperial for the United States, metric otherwise. */
export function unitSystemForRegion(region: string | null | undefined): UnitSystem {
  return region && IMPERIAL_REGIONS.has(region.toUpperCase()) ? "imperial" : "metric";
}

/**
 * The region of a locale (`es-US` is US, `fr` is FR), or null when it has none. Hermes, the engine Compass
 * runs on, has no `Intl.Locale`; there the region is read from the tag itself (`es-US` is US, `fr` none),
 * so a phone never stops on a locale lookup (A93 found the incident report crashing on it).
 */
export function regionOfLocale(locale: string): string | null {
  if (typeof Intl.Locale !== "function") {
    return (
      /^[a-z]{2,3}(?:-[A-Za-z]{4})?-([A-Za-z]{2}|\d{3})(?:-|$)/.exec(locale)?.[1]?.toUpperCase() ??
      null
    );
  }
  try {
    return new Intl.Locale(locale).maximize().region ?? null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * The unit system to show (locale.units): a fixed choice wins; "jurisdiction" follows the project's
 * jurisdiction when the page has one, and the region of the person's locale otherwise.
 */
export function resolveUnitSystem(
  preference: UnitsPreference,
  context: { readonly jurisdiction?: UnitSystem | null; readonly locale?: string } = {},
): UnitSystem {
  if (preference !== "jurisdiction") return preference;
  if (context.jurisdiction) return context.jurisdiction;
  return unitSystemForRegion(context.locale ? regionOfLocale(context.locale) : null);
}

/** A unit's short symbol in a locale, from Intl ("km/h", "mi", "°F"), for labels such as "Wind (km/h)". */
export function unitSymbol(locale: string, unit: MeasureUnit): string {
  const parts = new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
  }).formatToParts(1);
  return parts
    .filter((p) => p.type === "unit")
    .map((p) => p.value)
    .join("")
    .trim();
}

/** The unit a quantity shows in for a system. */
export function displayUnit(quantity: Quantity, system: UnitSystem): MeasureUnit {
  return DISPLAY[quantity][system];
}

/** The display unit for a value stored in `stored`: the same quantity, in the given system. */
export function displayUnitFor(stored: MeasureUnit, system: UnitSystem): MeasureUnit {
  return DISPLAY[QUANTITY[stored]][system];
}

/** Converts between two units of the same quantity (temperatures included). */
export function convertUnit(value: number, from: MeasureUnit, to: MeasureUnit): number {
  if (from === to) return value;
  if (QUANTITY[from] !== QUANTITY[to]) throw new Error(`Cannot convert ${from} to ${to}.`);
  if (QUANTITY[from] === "temperature") {
    return from === "fahrenheit" ? ((value - 32) * 5) / 9 : (value * 9) / 5 + 32;
  }
  return (value * (FACTOR[from] ?? 1)) / (FACTOR[to] ?? 1);
}

/** Rounds to a number of fraction digits, for values put back in a form. */
export function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * A value stored in `stored`, shown in the system's unit for that quantity and formatted by Intl for the
 * locale, for example 25 mph as "40 km/h" or 95 degrees Fahrenheit as "35°C".
 */
export function formatMeasure(
  locale: string,
  value: number,
  stored: MeasureUnit,
  system: UnitSystem,
  maximumFractionDigits = 1,
): string {
  const unit = displayUnitFor(stored, system);
  return formatUnit(locale, convertUnit(value, stored, unit), unit, maximumFractionDigits);
}

/** A value typed in the system's display unit, converted back to the stored unit before it is saved. */
export function toStoredUnit(value: number, stored: MeasureUnit, system: UnitSystem): number {
  return convertUnit(value, displayUnitFor(stored, system), stored);
}

/** A stored value converted to the system's display unit, rounded for a form field. */
export function toDisplayUnit(
  value: number,
  stored: MeasureUnit,
  system: UnitSystem,
  digits = 1,
): number {
  return roundTo(convertUnit(value, stored, displayUnitFor(stored, system)), digits);
}
