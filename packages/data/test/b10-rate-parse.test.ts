import { describe, expect, it } from "vitest";
import { parseRate, rateTypeOf } from "../src/import-rate.ts";

const EXPONENTS: Readonly<Record<string, number>> = { USD: 2, EUR: 2, CHF: 2, JPY: 0, MXN: 2 };
const exponentOf = (code: string) => EXPONENTS[code];

describe("parseRate (B10)", () => {
  it("reads each number format with its currency and rate type", () => {
    expect(parseRate("$1,250.50/day", "comma-dot", exponentOf, "USD")).toEqual({
      ok: true,
      minor: 125050,
      currency: "USD",
      basis: "Day",
    });
    expect(parseRate("1.250,50 €", "dot-comma", exponentOf, "USD")).toMatchObject({
      minor: 125050,
      currency: "EUR",
    });
    expect(parseRate("1 250,50 €", "space-comma", exponentOf, "USD")).toMatchObject({
      minor: 125050,
      currency: "EUR",
    });
    expect(parseRate("1 250,50 €", "space-comma", exponentOf, "USD")).toMatchObject({
      minor: 125050,
      currency: "EUR",
    });
    expect(parseRate("1'234.56 CHF", "apostrophe-dot", exponentOf, "USD")).toMatchObject({
      minor: 123456,
      currency: "CHF",
    });
    expect(parseRate("1’234.56 CHF", "apostrophe-dot", exponentOf, "USD")).toMatchObject({
      minor: 123456,
      currency: "CHF",
    });
    expect(parseRate("¥25,000", "comma-dot", exponentOf, "JPY")).toMatchObject({
      minor: 25000,
      currency: "JPY",
    });
    expect(parseRate("25 por hora", "comma-dot", exponentOf, null, "USD")).toEqual({
      ok: true,
      minor: 2500,
      currency: "USD",
      basis: "Hourly",
    });
  });

  it("reads the rate types in English and Spanish", () => {
    expect(parseRate("25/hr", "comma-dot", exponentOf, "USD")).toMatchObject({ basis: "Hourly" });
    expect(parseRate("250 per day", "comma-dot", exponentOf, "USD")).toMatchObject({
      basis: "Day",
    });
    expect(parseRate("250 por día", "comma-dot", exponentOf, "USD")).toMatchObject({
      basis: "Day",
    });
    expect(parseRate("500 flat", "comma-dot", exponentOf, "USD")).toMatchObject({ basis: "Flat" });
    expect(parseRate("500 fijo", "comma-dot", exponentOf, "USD")).toMatchObject({ basis: "Flat" });
    expect(parseRate("500", "comma-dot", exponentOf, "USD")).toMatchObject({ basis: null });
    expect(rateTypeOf("Por hora")).toBe("Hourly");
    expect(rateTypeOf("weekly")).toBeNull();
  });

  it("names the issue for what it cannot read", () => {
    const invalid = { ok: false, issue: "invalid_rate" };
    expect(parseRate("12.345", "comma-dot", exponentOf, "USD")).toEqual(invalid);
    expect(parseRate("-25", "comma-dot", exponentOf, "USD")).toEqual(invalid);
    expect(parseRate("1,250.50", "dot-comma", exponentOf, "USD")).toEqual(invalid);
    expect(parseRate("25.50", "comma-dot", exponentOf, "JPY", "JPY")).toEqual(invalid);
    expect(parseRate("99999999999999", "comma-dot", exponentOf, "USD")).toEqual(invalid);
    expect(parseRate("25 XYZ", "comma-dot", exponentOf, "USD")).toEqual(invalid);
    expect(parseRate("$25", "comma-dot", exponentOf, "EUR")).toEqual({
      ok: false,
      issue: "rate_currency_required",
    });
    expect(parseRate("25", "comma-dot", exponentOf, null)).toEqual({
      ok: false,
      issue: "rate_currency_required",
    });
  });
});
