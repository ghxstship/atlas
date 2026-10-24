import { preferencesFromSettings } from "@xos/ui/preferences";
import { describe, expect, it } from "vitest";
import {
  formatHazardValue,
  hazardUnitSymbol,
  storedHazardValue,
  unitSystemFor,
} from "../lib/workforce/units";

/**
 * Section 15 units on the weather board: wind, lightning distance and heat index are stored in mph, miles and
 * degrees Fahrenheit, and show in the person's units (locale.units): their choice, otherwise the project's
 * jurisdiction (imperial for the United States, metric otherwise), otherwise their locale's region.
 */

const units = (value: string | undefined) =>
  preferencesFromSettings(new Map(value ? [["locale.units", value]] : [])).units;

describe("weather values in the person's units (locale.units)", () => {
  it("follows the project's jurisdiction unless the person or org chose a system", () => {
    expect(unitSystemFor(units(undefined), "metric", "en-US")).toBe("metric");
    expect(unitSystemFor(units(undefined), "imperial", "de-DE")).toBe("imperial");
    expect(unitSystemFor(units(undefined), null, "en-US")).toBe("imperial");
    expect(unitSystemFor(units(undefined), null, "fr-FR")).toBe("metric");
    expect(unitSystemFor(units("imperial"), "metric", "fr-FR")).toBe("imperial");
    expect(unitSystemFor(units("metric"), "imperial", "en-US")).toBe("metric");
  });

  it("shows readings and thresholds converted, with Intl's unit", () => {
    expect(formatHazardValue("en-US", "Wind", 40, "imperial")).toBe("40 mph");
    expect(formatHazardValue("en-US", "Wind", 40, "metric")).toBe("64.4 km/h");
    expect(formatHazardValue("en-US", "Lightning", 6, "metric")).toBe("9.7 km");
    expect(formatHazardValue("en-US", "Heat", 95, "metric")).toBe("35°C");
    expect(formatHazardValue("en-US", "Heat", 95, "imperial")).toBe("95°F");
    expect(hazardUnitSymbol("en-US", "Wind", "metric")).toBe("km/h");
    expect(hazardUnitSymbol("en-US", "Heat", "imperial")).toBe("°F");
  });

  it("stores a value typed in metric in the hazard's own unit", () => {
    expect(storedHazardValue("Wind", 64.4, "metric")).toBe(40.02);
    expect(storedHazardValue("Heat", 35, "metric")).toBe(95);
    expect(storedHazardValue("Lightning", 6, "imperial")).toBe(6);
  });
});
