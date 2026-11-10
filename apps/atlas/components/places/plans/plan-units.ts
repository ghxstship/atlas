import { feetToMeters, sqFtToSqM } from "@xos/data/places-geometry";

/**
 * Plan measurements in the viewer's unit system (locale.units, resolved with unitSystemFor): feet are the stored unit
 * (ADR 0140 D4), and metric viewers read meters and square meters at 0.3048. Numbers keep two decimals at most.
 */
export type PlanUnits = "imperial" | "metric";

const number = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);

export function formatLength(feet: number, units: PlanUnits, locale: string): string {
  return units === "metric"
    ? `${number(feetToMeters(feet), locale)} m`
    : `${number(feet, locale)} ft`;
}

export function formatArea(sqFt: number, units: PlanUnits, locale: string): string {
  return units === "metric"
    ? `${number(sqFtToSqM(sqFt), locale)} m²`
    : `${number(sqFt, locale)} ${locale.startsWith("es") ? "ft²" : "sq ft"}`;
}
