import type { XosClient } from "@xos/data";
import { getProjectUnitSystem } from "@xos/data/jurisdiction-units";
import { HAZARD_MEASURES, HAZARD_UNITS, type WeatherHazard } from "@xos/data/workforce-site";
import {
  formatMeasure,
  resolveUnitSystem,
  roundTo,
  toStoredUnit,
  unitSymbol,
  displayUnitFor,
  type Units,
  type UnitSystem,
} from "@xos/ui/preferences";

/**
 * Units on the weather board (Section 15): wind, lightning distance and heat index are stored in mph, miles and
 * degrees Fahrenheit and shown in the person's units (locale.units): a system they or the org chose, otherwise
 * the project's jurisdiction (imperial in the United States, metric elsewhere), otherwise their locale's region.
 * A value typed in a form is converted back to the stored unit with the system the form was shown in.
 */

export const UNIT_SYSTEMS: readonly UnitSystem[] = ["imperial", "metric"];

/** The system to show a project's values in, from locale.units, the project's jurisdiction and the locale. */
export function unitSystemFor(
  preference: Units,
  jurisdiction: UnitSystem | null,
  locale: string,
): UnitSystem {
  return resolveUnitSystem(preference, { jurisdiction, locale });
}

/** The project's jurisdiction's unit system, or null when the project has none yet. */
export async function projectJurisdictionUnits(
  db: XosClient,
  projectId: string,
): Promise<UnitSystem | null> {
  const result = await getProjectUnitSystem(db, projectId);
  return result.ok ? result.data : null;
}

/** A hazard reading or threshold, stored in its hazard unit, in the system's unit: "40 km/h", "35°C". */
export function formatHazardValue(
  locale: string,
  hazard: WeatherHazard,
  value: number,
  system: UnitSystem,
): string {
  return formatMeasure(locale, value, HAZARD_MEASURES[HAZARD_UNITS[hazard].unit], system, 1);
}

/** The short symbol of a hazard's unit in the system: "km/h", "mi", "°C". */
export function hazardUnitSymbol(
  locale: string,
  hazard: WeatherHazard,
  system: UnitSystem,
): string {
  return unitSymbol(locale, displayUnitFor(HAZARD_MEASURES[HAZARD_UNITS[hazard].unit], system));
}

/** A value typed in the system's unit, as the hazard stores it (two decimals). */
export function storedHazardValue(
  hazard: WeatherHazard,
  typed: number,
  system: UnitSystem,
): number {
  return roundTo(toStoredUnit(typed, HAZARD_MEASURES[HAZARD_UNITS[hazard].unit], system), 2);
}
